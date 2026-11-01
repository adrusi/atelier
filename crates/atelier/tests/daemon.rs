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
        json!({ "protocolVersion": atelier_proto::PROTOCOL_VERSION, "role": "cli", "atelierDir": dir }),
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
    assert_eq!(
        init["result"]["protocolVersion"],
        json!(atelier_proto::PROTOCOL_VERSION)
    );
    assert_eq!(
        init["result"]["build"].as_str().map(str::len),
        Some(12),
        "a build id"
    );

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
        json!({ "protocolVersion": atelier_proto::PROTOCOL_VERSION, "role": "cli", "atelierDir": "/" }),
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

#[test]
fn requests_start_a_session_unless_one_is_at_work() {
    let env = Env::new();
    let out = env.root.join("sessions.out");
    write(
        &env.root.join("config/atelier"),
        "config.toml",
        &format!(
            "[session]\nstart = \"headless\"\ncommand = 'printf \"%s %s %s\\n\" \"$ATELIER_SESSION\" \"$ATELIER_TASK_ID\" {{dir}} >> {}'\n",
            out.display()
        ),
    );
    let mut daemon = env.daemon();
    let mut s = env.connect();
    initialize(&mut s, &env.dir);
    let create = |s: &mut UnixStream, id: u64| {
        call(
            s,
            id,
            "task/create",
            json!({ "kind": "create", "brief": { "description": "style it" } }),
        )["result"]["id"]
            .as_str()
            .unwrap()
            .to_string()
    };
    let lines = || {
        std::fs::read_to_string(&out)
            .unwrap_or_default()
            .lines()
            .map(str::to_string)
            .collect::<Vec<_>>()
    };
    let wait_for = |n: usize| {
        let deadline = Instant::now() + Duration::from_secs(5);
        while lines().len() < n && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(50));
        }
        lines()
    };

    // A request from the user (here, the CLI) starts one, told it's headless.
    let first = create(&mut s, 1);
    let started = wait_for(1);
    assert_eq!(started.len(), 1);
    assert_eq!(
        started[0],
        format!(
            "headless {first} {}",
            env.dir.canonicalize().unwrap().display()
        )
    );

    // Another request while that session is on its way doesn't start a second.
    create(&mut s, 2);
    std::thread::sleep(Duration::from_millis(300));
    assert_eq!(lines().len(), 1);

    // Tasks agents create are for their own session.
    let mut agent = env.connect();
    call(
        &mut agent,
        0,
        "initialize",
        json!({ "protocolVersion": atelier_proto::PROTOCOL_VERSION, "role": "mcp" }),
    );
    let forced = call(&mut s, 3, "session/start", json!({ "force": true }))["result"].clone();
    assert_eq!(forced["started"], json!(true), "{forced}");
    wait_for(2);
    call(&mut agent, 1, "task/claim", json!({ "session": "a1" }));
    // The claim says a session is at work, so neither starts one.
    create(&mut agent, 2);
    create(&mut s, 4);
    std::thread::sleep(Duration::from_millis(300));
    assert_eq!(lines().len(), 2);
    let busy = call(&mut s, 5, "session/start", json!({}))["result"].clone();
    assert_eq!(busy["started"], json!(false));
    assert!(
        busy["reason"].as_str().unwrap().contains("working"),
        "{busy}"
    );

    daemon.kill().unwrap();
    daemon.wait().unwrap();
}

/// Starts a landing (or an undo) in a daemon told to stop at `point`, then
/// restarts the daemon normally and returns the connection to it.
fn crash_then_restart(
    env: &Env,
    point: &str,
    setup: impl FnOnce(&mut UnixStream),
) -> (Child, UnixStream) {
    let mut crashing = env
        .command()
        .args(["daemon", "--dir"])
        .arg(&env.dir)
        .env("ATELIER_CRASH_AT", point)
        .spawn()
        .unwrap();
    let mut s = env.connect();
    initialize(&mut s, &env.dir);
    setup(&mut s);
    let status = crashing.wait().unwrap();
    assert_eq!(status.code(), Some(86), "the daemon stopped at {point}");
    // The dead daemon's socket is still on disk; wait for the new one.
    let socket_dir = env.root.join("run/atelier");
    for e in std::fs::read_dir(&socket_dir).unwrap().flatten() {
        let _ = std::fs::remove_file(e.path());
    }
    let daemon = env.daemon();
    let mut s = env.connect();
    initialize(&mut s, &env.dir);
    (daemon, s)
}

fn land_blue(s: &mut UnixStream) -> String {
    let id = call(
        s,
        1,
        "task/create",
        json!({ "kind": "revise", "service": "site", "brief": { "description": "make it blue" } }),
    )["result"]["id"]
        .as_str()
        .unwrap()
        .to_string();
    let claimed = call(s, 2, "task/claim", json!({ "session": "s1" }))["result"].clone();
    write(
        &PathBuf::from(claimed["tree"].as_str().unwrap()),
        "services/site/dusk/a.user.css",
        "@-moz-document domain(\"example.com\") { body { color: blue; } }\n",
    );
    // The daemon stops partway through this, so there's no reply to wait for.
    send(
        s,
        json!({ "jsonrpc": "2.0", "id": 3, "method": "task/submit", "params": { "id": id, "session": "s1", "summary": "Blue" } }),
    );
    id
}

#[test]
fn a_landing_interrupted_at_any_point_is_finished_on_restart() {
    for point in ["journal-intent", "journal-files"] {
        let env = Env::new();
        let hook_out = env.root.join("hook.out");
        write(
            &env.root.join("config/atelier"),
            "config.toml",
            &format!("[hooks]\non_land = \"cat > {}\"\n", hook_out.display()),
        );
        let style = env.dir.join("services/site/dusk/a.user.css");
        let mut task = String::new();
        let (mut daemon, mut s) = crash_then_restart(&env, point, |s| task = land_blue(s));

        assert!(
            std::fs::read_to_string(&style).unwrap().contains("blue"),
            "{point}: the files are written"
        );
        let t = call(&mut s, 10, "task/get", json!({ "id": task }))["result"].clone();
        assert_eq!(t["state"], json!("landed"), "{point}: {t}");
        assert_eq!(t["outcome"]["journal"], json!(1));
        let journal = call(&mut s, 11, "journal/list", json!({}))["result"].clone();
        assert_eq!(journal[0]["summary"], json!("Blue"));
        // The hook the interrupted landing never ran.
        let deadline = Instant::now() + Duration::from_secs(5);
        while !hook_out.exists() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(50));
        }
        std::thread::sleep(Duration::from_millis(100));
        assert_eq!(
            std::fs::read_to_string(&hook_out).unwrap(),
            "Blue",
            "{point}"
        );

        daemon.kill().unwrap();
        daemon.wait().unwrap();
    }
}

#[test]
fn an_interrupted_undo_is_finished_on_restart() {
    let env = Env::new();
    let style = env.dir.join("services/site/dusk/a.user.css");
    let mut first = env.daemon();
    {
        let mut s = env.connect();
        initialize(&mut s, &env.dir);
        land_blue(&mut s);
        let deadline = Instant::now() + Duration::from_secs(5);
        while !std::fs::read_to_string(&style).unwrap().contains("blue")
            && Instant::now() < deadline
        {
            std::thread::sleep(Duration::from_millis(50));
        }
    }
    first.kill().unwrap();
    first.wait().unwrap();
    for e in std::fs::read_dir(env.root.join("run/atelier"))
        .unwrap()
        .flatten()
    {
        let _ = std::fs::remove_file(e.path());
    }

    let (mut daemon, mut s) = crash_then_restart(&env, "journal-intent", |s| {
        send(
            s,
            json!({ "jsonrpc": "2.0", "id": 5, "method": "journal/undo", "params": {} }),
        );
    });
    assert!(
        std::fs::read_to_string(&style).unwrap().contains("red"),
        "restored"
    );
    let journal = call(&mut s, 10, "journal/list", json!({}))["result"].clone();
    assert_eq!(journal[0]["undoOf"], json!(1));
    assert_eq!(journal[1]["undoneBy"], json!(2));
    daemon.kill().unwrap();
    daemon.wait().unwrap();
}

/// Sends one native-messaging message (length-prefixed JSON) and reads one.
fn native_exchange(child: &mut Child, msg: &Value) -> Value {
    let stdin = child.stdin.as_mut().unwrap();
    let body = serde_json::to_vec(msg).unwrap();
    stdin.write_all(&(body.len() as u32).to_ne_bytes()).unwrap();
    stdin.write_all(&body).unwrap();
    stdin.flush().unwrap();
    let stdout = child.stdout.as_mut().unwrap();
    let mut len = [0u8; 4];
    stdout.read_exact(&mut len).unwrap();
    let mut buf = vec![0u8; u32::from_ne_bytes(len) as usize];
    stdout.read_exact(&mut buf).unwrap();
    serde_json::from_slice(&buf).unwrap()
}

#[test]
fn the_native_host_replaces_a_daemon_from_another_build() {
    let env = Env::new();
    // Another build: the same binary at another path has another build id.
    let other = env.root.join("other-atelier");
    std::fs::copy(env!("CARGO_BIN_EXE_atelier"), &other).unwrap();
    let mut stale = Command::new(&other);
    for (var, sub) in [
        ("XDG_RUNTIME_DIR", "run"),
        ("XDG_STATE_HOME", "state"),
        ("XDG_CONFIG_HOME", "config"),
        ("XDG_DATA_HOME", "data"),
    ] {
        stale.env(var, env.root.join(sub));
    }
    let mut stale = stale
        .args(["daemon", "--dir"])
        .arg(&env.dir)
        .spawn()
        .unwrap();
    let mut s = env.connect();
    let before = initialize(&mut s, &env.dir)["result"].clone();
    assert_eq!(before["pid"], json!(stale.id()));
    drop(s);

    let mut host = env
        .command()
        .arg("native-host")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    let reply = native_exchange(
        &mut host,
        &json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize",
            "params": { "protocolVersion": atelier_proto::PROTOCOL_VERSION, "role": "extension", "atelierDir": env.dir } }),
    );
    let after = &reply["result"];
    assert_ne!(after["build"], before["build"], "{reply}");
    assert_ne!(after["pid"], before["pid"]);
    let deadline = Instant::now() + Duration::from_secs(5);
    while stale.try_wait().unwrap().is_none() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(50));
    }
    assert!(
        stale.try_wait().unwrap().is_some(),
        "the other build's daemon exited"
    );

    host.kill().unwrap();
    host.wait().unwrap();
    // The new daemon runs on its own (its own process group); stop it.
    let pid = after["pid"].as_u64().unwrap();
    let _ = Command::new("kill").arg(pid.to_string()).status();
}

#[test]
fn session_status_says_how_sessions_start_and_whether_one_is_starting() {
    let env = Env::new();
    let mut daemon = env.daemon();
    let mut s = env.connect();
    initialize(&mut s, &env.dir);
    let status = call(&mut s, 1, "session/status", json!({}))["result"].clone();
    assert_eq!(
        status,
        json!({ "start": "pull", "command": false, "working": false, "waiting": false, "starting": false })
    );
    daemon.kill().unwrap();
    daemon.wait().unwrap();

    // Configured to start sessions: a request starts one, and it's starting.
    write(
        &env.root.join("config/atelier"),
        "config.toml",
        "[session]\nstart = \"headless\"\ncommand = 'true'\n",
    );
    for e in std::fs::read_dir(env.root.join("run/atelier"))
        .unwrap()
        .flatten()
    {
        let _ = std::fs::remove_file(e.path());
    }
    let mut daemon = env.daemon();
    let mut s = env.connect();
    initialize(&mut s, &env.dir);
    call(
        &mut s,
        2,
        "task/create",
        json!({ "kind": "create", "brief": { "description": "Style it" } }),
    );
    let status = call(&mut s, 3, "session/status", json!({}))["result"].clone();
    assert_eq!(status["start"], json!("headless"));
    assert_eq!(status["command"], json!(true));
    assert_eq!(status["starting"], json!(true), "{status}");
    daemon.kill().unwrap();
    daemon.wait().unwrap();
}

/// Runs `atelier agent-hook` under a stand-in harness (a shell whose pid is
/// ATELIER_AGENT_PID), and returns what the hook printed and whether the
/// harness was ended within a few seconds.
fn agent_hook(env: &Env, which: &str, event: Value) -> (String, bool) {
    let mut c = Command::new("sh");
    c.arg("-c")
        .arg(r#"printf '%s' "$1" | ATELIER_AGENT_PID=$$ "$0" --dir "$2" agent-hook "$3"; sleep 6"#)
        .arg(env!("CARGO_BIN_EXE_atelier"))
        .arg(event.to_string())
        .arg(&env.dir)
        .arg(which)
        .stdout(std::process::Stdio::piped());
    for (var, sub) in [
        ("XDG_RUNTIME_DIR", "run"),
        ("XDG_STATE_HOME", "state"),
        ("XDG_CONFIG_HOME", "config"),
        ("XDG_DATA_HOME", "data"),
    ] {
        c.env(var, env.root.join(sub));
    }
    let mut harness = c.spawn().unwrap();
    let deadline = Instant::now() + Duration::from_secs(4);
    let ended = loop {
        if let Some(status) = harness.try_wait().unwrap() {
            break !status.success();
        }
        if Instant::now() > deadline {
            harness.kill().unwrap();
            harness.wait().unwrap();
            break false;
        }
        std::thread::sleep(Duration::from_millis(100));
    };
    let mut out = String::new();
    harness
        .stdout
        .take()
        .unwrap()
        .read_to_string(&mut out)
        .unwrap();
    (out, ended)
}

#[test]
fn the_stop_hook_ends_a_finished_agent_session_and_keeps_a_busy_one_going() {
    let env = Env::new();
    let mut daemon = env.daemon();
    let mut s = env.connect();
    initialize(&mut s, &env.dir);
    let stop = |active: bool| json!({ "session_id": "c1", "stop_hook_active": active });

    // Work waiting in the queue: the agent is asked to carry on, once.
    call(
        &mut s,
        1,
        "task/create",
        json!({ "kind": "create", "brief": { "description": "Style it" } }),
    );
    let (out, ended) = agent_hook(&env, "stop", stop(false));
    assert!(out.contains(r#""decision":"block""#), "{out}");
    assert!(!ended);
    let (out, ended) = agent_hook(&env, "stop", stop(true));
    assert!(
        out.is_empty() && !ended,
        "asked once already: left open ({out})"
    );

    // Nothing left for it (the task is someone else's): the session ends.
    call(&mut s, 2, "task/claim", json!({ "session": "s1" }));
    let (_, ended) = agent_hook(&env, "stop", stop(false));
    assert!(ended, "a finished session is ended");

    // Once the user has said something to it, it's theirs.
    agent_hook(
        &env,
        "prompt",
        json!({ "session_id": "c2", "prompt": "I'd like your help with atelier's queue. …" }),
    );
    let (_, ended) = agent_hook(&env, "stop", json!({ "session_id": "c2" }));
    assert!(ended, "the work prompt isn't the user talking");
    agent_hook(
        &env,
        "prompt",
        json!({ "session_id": "c3", "prompt": "why that colour?" }),
    );
    let (_, ended) = agent_hook(&env, "stop", json!({ "session_id": "c3" }));
    assert!(!ended, "a session the user talked to stays open");
    daemon.kill().unwrap();
    daemon.wait().unwrap();
}
