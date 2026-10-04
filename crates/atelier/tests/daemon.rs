//! Runs a real daemon against a temporary owned directory and talks to it
//! over its socket, as the native host and CLI do.

use base64::Engine;
use serde_json::{Value, json};
use std::io::{Read, Write};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command};
use std::time::{Duration, Instant};

struct Env {
    _tmp: tempfile::TempDir,
    root: PathBuf,
    dir: PathBuf,
}

impl Env {
    fn new() -> Env {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().to_path_buf();
        let dir = root.join("data/atelier");
        write(&dir, "atelier.toml", "theme = \"dusk\"\n");
        write(
            &dir,
            "services/site/dusk/a.user.css",
            "@-moz-document domain(\"example.com\") { body { color: red; } }\n",
        );
        Env {
            _tmp: tmp,
            root,
            dir,
        }
    }

    fn command(&self) -> Command {
        let mut c = Command::new(env!("CARGO_BIN_EXE_atelier"));
        for (var, sub) in [
            ("XDG_RUNTIME_DIR", "run"),
            ("XDG_STATE_HOME", "state"),
            ("XDG_CONFIG_HOME", "config"),
            ("XDG_DATA_HOME", "data"),
        ] {
            c.env(var, self.root.join(sub));
        }
        c.env("ATELIER_DAEMON_IDLE_SECS", "60");
        c
    }

    fn daemon(&self) -> Child {
        self.command()
            .args(["daemon", "--dir"])
            .arg(&self.dir)
            .spawn()
            .unwrap()
    }

    fn connect(&self) -> UnixStream {
        let run = self.root.join("run/atelier");
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            let socket = std::fs::read_dir(&run).ok().and_then(|mut d| {
                d.find_map(|e| {
                    e.ok()
                        .map(|e| e.path())
                        .filter(|p| p.extension().is_some_and(|x| x == "sock"))
                })
            });
            if let Some(s) = socket.and_then(|p| UnixStream::connect(p).ok()) {
                s.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
                return s;
            }
            assert!(Instant::now() < deadline, "daemon socket never appeared");
            std::thread::sleep(Duration::from_millis(50));
        }
    }
}

fn write(dir: &Path, path: &str, content: &str) {
    let p = dir.join(path);
    std::fs::create_dir_all(p.parent().unwrap()).unwrap();
    std::fs::write(p, content).unwrap();
}

fn send(s: &mut UnixStream, msg: Value) {
    let buf = serde_json::to_vec(&msg).unwrap();
    s.write_all(&(buf.len() as u32).to_le_bytes()).unwrap();
    s.write_all(&buf).unwrap();
}

fn recv(s: &mut UnixStream) -> Value {
    let mut len = [0u8; 4];
    s.read_exact(&mut len).unwrap();
    let mut buf = vec![0u8; u32::from_le_bytes(len) as usize];
    s.read_exact(&mut buf).unwrap();
    serde_json::from_slice(&buf).unwrap()
}

fn call(s: &mut UnixStream, id: u64, method: &str, params: Value) -> Value {
    send(
        s,
        json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }),
    );
    loop {
        let msg = recv(s);
        if msg["id"] == json!(id) {
            return msg;
        }
    }
}

fn initialize(s: &mut UnixStream, dir: &Path) -> Value {
    call(
        s,
        0,
        "initialize",
        json!({ "protocolVersion": 1, "role": "cli", "atelierDir": dir }),
    )
}

fn fetch_bundle(s: &mut UnixStream, blob: &Value) -> Value {
    let mut bytes = Vec::new();
    for id in 100.. {
        // A tiny length forces several chunks.
        let r = call(
            s,
            id,
            "blob/get",
            json!({ "hash": blob["hash"], "offset": bytes.len(), "len": 100 }),
        );
        let chunk = &r["result"];
        bytes.extend(
            base64::engine::general_purpose::STANDARD
                .decode(chunk["data"].as_str().unwrap())
                .unwrap(),
        );
        if chunk["eof"] == json!(true) {
            break;
        }
    }
    assert_eq!(bytes.len() as u64, blob["size"].as_u64().unwrap());
    serde_json::from_slice(&bytes).unwrap()
}

#[test]
fn serves_bundle_and_pushes_changes() {
    let env = Env::new();
    let mut daemon = env.daemon();
    let mut s = env.connect();

    let init = initialize(&mut s, &env.dir);
    assert_eq!(init["result"]["protocolVersion"], json!(1));

    let blob = call(&mut s, 1, "bundle/get", Value::Null)["result"].clone();
    let bundle = fetch_bundle(&mut s, &blob);
    assert_eq!(bundle["theme"], json!("dusk"));
    assert_eq!(
        bundle["styles"][0]["id"],
        json!("services/site/dusk/a.user.css")
    );

    // Editing a style pushes bundle/changed with a new hash.
    write(
        &env.dir,
        "services/site/dusk/a.user.css",
        "@-moz-document domain(\"example.com\") { body { color: blue; } }\n",
    );
    let changed = loop {
        let msg = recv(&mut s);
        if msg["method"] == json!("bundle/changed") {
            break msg["params"].clone();
        }
    };
    assert_ne!(changed["hash"], blob["hash"]);
    let bundle = fetch_bundle(&mut s, &changed);
    assert!(
        bundle["styles"][0]["sections"][0]["css"]
            .as_str()
            .unwrap()
            .contains("blue")
    );

    // So does editing vars.json.
    write(
        &env.dir,
        "services/site/dusk/b.user.css",
        "/* ==UserStyle==\n@var color c \"C\" #000\n==/UserStyle== */\n@-moz-document domain(\"example.com\") { p { color: var(--c); } }\n",
    );
    let _ = loop {
        let msg = recv(&mut s);
        if msg["method"] == json!("bundle/changed") {
            break msg;
        }
    };
    write(
        &env.root.join("config/atelier"),
        "vars.json",
        "{ \"c\": \"#abcdef\" }",
    );
    let changed = loop {
        let msg = recv(&mut s);
        if msg["method"] == json!("bundle/changed") {
            break msg["params"].clone();
        }
    };
    let bundle = fetch_bundle(&mut s, &changed);
    assert_eq!(
        bundle["styles"][1]["varsCss"],
        json!(":root { --c: #abcdef; }")
    );

    let status = call(&mut s, 2, "status", Value::Null);
    assert_eq!(status["result"]["clients"]["cli"], json!(1));

    daemon.kill().unwrap();
    daemon.wait().unwrap();
}

#[test]
fn a_broken_save_keeps_the_last_good_version() {
    let env = Env::new();
    let mut daemon = env.daemon();
    let mut s = env.connect();
    initialize(&mut s, &env.dir);

    // An unclosed block: the file no longer parses.
    write(
        &env.dir,
        "services/site/dusk/a.user.css",
        "@-moz-document domain(\"example.com\") { body { color: green; }\n",
    );
    let changed = loop {
        let msg = recv(&mut s);
        if msg["method"] == json!("bundle/changed") {
            break msg["params"].clone();
        }
    };
    let bundle = fetch_bundle(&mut s, &changed);
    assert_eq!(
        bundle["styles"].as_array().unwrap().len(),
        1,
        "the style is still there"
    );
    assert!(
        bundle["styles"][0]["sections"][0]["css"]
            .as_str()
            .unwrap()
            .contains("red"),
        "in its last good version"
    );
    let diags = bundle["diagnostics"].as_array().unwrap();
    assert!(diags.iter().any(|d| d["severity"] == json!("error")));
    assert!(diags.iter().any(|d| {
        d["message"]
            .as_str()
            .unwrap()
            .contains("last version that loaded")
    }));

    // Deleting it really removes it.
    std::fs::remove_file(env.dir.join("services/site/dusk/a.user.css")).unwrap();
    let changed = loop {
        let msg = recv(&mut s);
        if msg["method"] == json!("bundle/changed") {
            break msg["params"].clone();
        }
    };
    assert_eq!(fetch_bundle(&mut s, &changed)["styles"], json!([]));

    daemon.kill().unwrap();
    daemon.wait().unwrap();
}

#[test]
fn rejects_bad_initialization() {
    let env = Env::new();
    let mut daemon = env.daemon();

    let mut s = env.connect();
    let r = call(&mut s, 1, "status", Value::Null);
    assert_eq!(r["error"]["code"], json!(-32002));

    let mut s = env.connect();
    let r = call(
        &mut s,
        1,
        "initialize",
        json!({ "protocolVersion": 99, "role": "cli" }),
    );
    assert!(r["error"]["message"].as_str().unwrap().contains("99"));

    let mut s = env.connect();
    let r = call(
        &mut s,
        1,
        "initialize",
        json!({ "protocolVersion": 1, "role": "cli", "atelierDir": "/" }),
    );
    assert!(r["error"]["message"].as_str().unwrap().contains("serves"));

    daemon.kill().unwrap();
    daemon.wait().unwrap();
}

#[test]
fn only_one_daemon_per_directory() {
    let env = Env::new();
    let mut first = env.daemon();
    let _ = env.connect();
    let second = env
        .command()
        .args(["daemon", "--dir"])
        .arg(&env.dir)
        .output()
        .unwrap();
    assert!(second.status.success());
    assert!(String::from_utf8_lossy(&second.stderr).contains("already running"));
    first.kill().unwrap();
    first.wait().unwrap();
}

#[test]
fn tasks_land_through_the_daemon_with_hooks_and_undo() {
    let env = Env::new();
    // A hook that records what it was told.
    let hook_out = env.root.join("hook.out");
    write(
        &env.root.join("config/atelier"),
        "config.toml",
        &format!(
            "[hooks]\non_land = \"printf '%s %s %s ' \\\"$ATELIER_TASK_ID\\\" \\\"$ATELIER_SERVICE\\\" \\\"$ATELIER_JOURNAL_SEQ\\\" > {0}; cat >> {0}\"\n",
            hook_out.display()
        ),
    );
    let mut daemon = env.daemon();
    let mut s = env.connect();
    initialize(&mut s, &env.dir);

    let task = call(
        &mut s,
        1,
        "task/create",
        json!({ "kind": "revise", "service": "site", "brief": { "description": "make it blue" } }),
    )["result"]
        .clone();
    let id = task["id"].as_str().unwrap().to_string();
    assert_eq!(task["state"], json!("queued"));
    let claimed = call(&mut s, 2, "task/claim", json!({ "session": "s1" }))["result"].clone();
    assert_eq!(claimed["id"], json!(id));
    let tree = PathBuf::from(claimed["tree"].as_str().unwrap());

    write(
        &tree,
        "services/site/dusk/a.user.css",
        "@-moz-document domain(\"example.com\") { body { color: blue; } }\n",
    );
    let r = call(
        &mut s,
        3,
        "task/submit",
        json!({ "id": id, "session": "s1", "summary": "Make the body blue" }),
    )["result"]
        .clone();
    assert_eq!(r["result"], json!("landed"), "{r}");
    assert!(
        std::fs::read_to_string(env.dir.join("services/site/dusk/a.user.css"))
            .unwrap()
            .contains("blue")
    );

    // The landing reloads the bundle like any other file change.
    let changed = loop {
        let msg = recv(&mut s);
        if msg["method"] == json!("bundle/changed") {
            break msg["params"].clone();
        }
    };
    assert!(
        fetch_bundle(&mut s, &changed)["styles"][0]["sections"][0]["css"]
            .as_str()
            .unwrap()
            .contains("blue")
    );

    // The hook ran with the task's details and the summary on stdin.
    let deadline = Instant::now() + Duration::from_secs(5);
    while !hook_out.exists() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(50));
    }
    std::thread::sleep(Duration::from_millis(100));
    assert_eq!(
        std::fs::read_to_string(&hook_out).unwrap(),
        format!("{id} site 1 Make the body blue")
    );

    let undo = call(&mut s, 4, "journal/undo", json!({}))["result"].clone();
    assert_eq!(undo["undoOf"], json!(1));
    assert!(
        std::fs::read_to_string(env.dir.join("services/site/dusk/a.user.css"))
            .unwrap()
            .contains("red")
    );
    let journal = call(&mut s, 5, "journal/list", json!({}))["result"].clone();
    assert_eq!(journal.as_array().unwrap().len(), 2);

    // Refusals come back as errors with a reason.
    let refused = call(
        &mut s,
        6,
        "task/claim",
        json!({ "id": id, "session": "s1" }),
    );
    assert!(
        refused["error"]["message"]
            .as_str()
            .unwrap()
            .contains("landed")
    );

    daemon.kill().unwrap();
    daemon.wait().unwrap();
}

#[test]
fn task_trees_are_served_as_sources() {
    let env = Env::new();
    let mut daemon = env.daemon();
    let mut s = env.connect();
    initialize(&mut s, &env.dir);

    let id = call(
        &mut s,
        1,
        "task/create",
        json!({ "kind": "revise", "service": "site", "brief": { "description": "make it blue" } }),
    )["result"]["id"]
        .as_str()
        .unwrap()
        .to_string();
    let unclaimed = call(&mut s, 2, "bundle/get", json!({ "source": id }));
    assert_eq!(unclaimed["error"]["code"], json!(-32031), "{unclaimed}");

    let claimed = call(&mut s, 3, "task/claim", json!({ "session": "s1" }))["result"].clone();
    let tree = PathBuf::from(claimed["tree"].as_str().unwrap());
    let css = |s: &mut UnixStream, blob: &Value| {
        fetch_bundle(s, blob)["styles"][0]["sections"][0]["css"]
            .as_str()
            .unwrap()
            .to_string()
    };
    let first = call(&mut s, 4, "bundle/get", json!({ "source": id }))["result"].clone();
    assert!(css(&mut s, &first).contains("red"));

    // A save in the tree changes the source's bundle, not the owned directory's.
    write(
        &tree,
        "services/site/dusk/a.user.css",
        "@-moz-document domain(\"example.com\") { body { color: blue; } }\n",
    );
    let changed = loop {
        let msg = recv(&mut s);
        if msg["method"] == json!("bundle/changed") {
            break msg["params"].clone();
        }
    };
    assert_eq!(changed["source"], json!(id));
    assert!(css(&mut s, &changed).contains("blue"));
    let default = call(&mut s, 5, "bundle/get", json!({}))["result"].clone();
    assert!(css(&mut s, &default).contains("red"));
    let status = call(&mut s, 6, "status", json!({ "source": id }))["result"].clone();
    assert_eq!(status["bundleHash"], changed["hash"]);

    // Once the task finishes, its tree is no longer a source.
    call(&mut s, 7, "task/abandon", json!({ "id": id }));
    let finished = call(&mut s, 8, "bundle/get", json!({ "source": id }));
    assert!(
        finished["error"]["message"]
            .as_str()
            .unwrap()
            .contains("finished"),
        "{finished}"
    );

    daemon.kill().unwrap();
    daemon.wait().unwrap();
}
