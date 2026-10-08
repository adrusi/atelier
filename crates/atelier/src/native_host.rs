//! The native-messaging host (SPEC §4).
//!
//! Firefox starts this when the extension connects. It speaks native
//! messaging's framing on stdio (a 4-byte native-endian length, then UTF-8
//! JSON) and relays JSON-RPC messages to and from the daemon for the owned
//! directory named in the extension's `initialize`, starting the daemon if
//! it isn't running.
//!
//! If the first message isn't `initialize`, the host falls back to log mode:
//! it records every message, answers `ping`, and relays nothing. The spikes
//! (spikes/) use this to report results through the host's log.

use crate::{paths, wire};
use atelier_proto::method;
use serde_json::{Value, json};
use std::fs::{File, OpenOptions};
use std::io::{self, Read, Write};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::net::UnixStream;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, ExitCode, Stdio};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// Firefox rejects messages from the host larger than this.
const MAX_OUTGOING: usize = 1024 * 1024;

pub fn run(args: &[String]) -> ExitCode {
    let mut stdin = io::stdin().lock();
    let first = match receive(&mut stdin) {
        Ok(Some(msg)) => msg,
        Ok(None) => return ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("atelier native-host: {e}");
            return ExitCode::FAILURE;
        }
    };
    if first.get("method").and_then(Value::as_str) == Some(method::INITIALIZE) {
        relay(first, stdin)
    } else {
        log_mode(args, first, stdin)
    }
}

fn relay(init: Value, mut stdin: impl Read) -> ExitCode {
    let id = init.get("id").cloned().unwrap_or(Value::Null);
    let fail = |message: String| {
        eprintln!("atelier native-host: {message}");
        let _ = send(
            &mut io::stdout().lock(),
            &wire::error_response(id.clone(), wire::code::INTERNAL, message),
        );
        ExitCode::FAILURE
    };

    let asked = init.pointer("/params/atelierDir").and_then(Value::as_str);
    let dir = match paths::resolve_dir(asked) {
        Ok(d) => d,
        Err(e) => return fail(e.to_string()),
    };
    // A daemon left running from another build (atelier was updated while
    // it served the browser) is replaced by this one's.
    if let Err(e) = replace_other_build(&dir) {
        eprintln!("atelier native-host: couldn't replace the running daemon: {e}");
    }
    let stream = match connect_or_spawn(&dir) {
        Ok(s) => s,
        Err(e) => return fail(format!("can't reach the daemon for {}: {e}", dir.display())),
    };
    let (mut to_daemon, mut from_daemon) = match stream.try_clone() {
        Ok(clone) => (stream, clone),
        Err(e) => return fail(e.to_string()),
    };
    if let Err(e) = wire::write_frame(&mut to_daemon, &init) {
        return fail(e.to_string());
    }

    std::thread::spawn(move || {
        let mut stdout = io::stdout().lock();
        loop {
            match wire::read_frame(&mut from_daemon) {
                Ok(Some(msg)) => {
                    if let Err(e) = send(&mut stdout, &msg) {
                        eprintln!("atelier native-host: to extension: {e}");
                        std::process::exit(1);
                    }
                }
                Ok(None) => std::process::exit(0),
                Err(e) => {
                    eprintln!("atelier native-host: from daemon: {e}");
                    std::process::exit(1);
                }
            }
        }
    });

    loop {
        match receive(&mut stdin) {
            Ok(Some(msg)) => {
                if let Err(e) = wire::write_frame(&mut to_daemon, &msg) {
                    eprintln!("atelier native-host: to daemon: {e}");
                    return ExitCode::FAILURE;
                }
            }
            Ok(None) => return ExitCode::SUCCESS,
            Err(e) => {
                eprintln!("atelier native-host: from extension: {e}");
                return ExitCode::FAILURE;
            }
        }
    }
}

/// If a daemon from another build of atelier serves `dir`, stops it, so
/// `connect_or_spawn` starts this build's. Only the native host does this:
/// its binary is the installed one (the one Firefox's manifest names), so a
/// CLI or agent session from some other build never displaces it.
fn replace_other_build(dir: &Path) -> io::Result<()> {
    let socket = paths::socket_path(dir);
    let Ok(mut s) = UnixStream::connect(&socket) else {
        return Ok(()); // nothing running
    };
    s.set_read_timeout(Some(Duration::from_secs(5)))?;
    let hello = json!({ "jsonrpc": "2.0", "id": 1, "method": method::INITIALIZE,
        "params": { "protocolVersion": atelier_proto::PROTOCOL_VERSION, "role": "nativeHost" } });
    wire::write_frame(&mut s, &hello)?;
    let reply = wire::read_frame(&mut s)?.unwrap_or(Value::Null);
    let build = reply
        .pointer("/result/build")
        .and_then(Value::as_str)
        .unwrap_or("");
    if build == paths::build_id() {
        return Ok(());
    }
    eprintln!(
        "atelier native-host: the daemon for {} is another build ({}), replacing it with this one ({})",
        dir.display(),
        if build.is_empty() { "older" } else { build },
        paths::build_id()
    );
    if reply.get("result").is_some() && !build.is_empty() {
        // A daemon that knows how to stop when asked.
        let _ = wire::write_frame(
            &mut s,
            &json!({ "jsonrpc": "2.0", "id": 2, "method": method::DAEMON_EXIT, "params": {} }),
        );
    } else {
        // An older one: find its process by its command line, and stop it.
        stop_daemon_process(dir);
    }
    drop(s);
    // Wait until it has let go of the socket.
    let deadline = Instant::now() + Duration::from_secs(5);
    while UnixStream::connect(&socket).is_ok() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(50));
    }
    Ok(())
}

/// Stops `atelier daemon --dir <dir>` processes (Linux: by /proc), for
/// daemons from before `daemon/exit`.
fn stop_daemon_process(dir: &Path) {
    let Ok(entries) = std::fs::read_dir("/proc") else {
        return;
    };
    for e in entries.flatten() {
        let Some(pid) = e.file_name().to_str().and_then(|p| p.parse::<i32>().ok()) else {
            continue;
        };
        let Ok(cmdline) = std::fs::read(e.path().join("cmdline")) else {
            continue;
        };
        let args: Vec<&[u8]> = cmdline.split(|b| *b == 0).collect();
        let is_daemon = args.iter().any(|a| *a == b"daemon")
            && args
                .windows(2)
                .any(|w| w[0] == b"--dir" && Path::new(std::ffi::OsStr::from_bytes(w[1])) == dir)
            && args.first().is_some_and(|a| a.ends_with(b"atelier"));
        if is_daemon {
            let _ = Command::new("kill").arg(pid.to_string()).status();
        }
    }
}

pub(crate) fn connect_or_spawn(dir: &Path) -> io::Result<UnixStream> {
    let socket = paths::socket_path(dir);
    paths::check_socket_path(&socket)?;
    if let Ok(s) = UnixStream::connect(&socket) {
        return Ok(s);
    }
    spawn_daemon(dir)?;
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        match UnixStream::connect(&socket) {
            Ok(s) => return Ok(s),
            Err(e) if Instant::now() >= deadline => return Err(e),
            Err(_) => std::thread::sleep(Duration::from_millis(50)),
        }
    }
}

/// Starts `atelier daemon` for `dir` in its own process group, so it outlives
/// this host, logging to the directory's state dir. If another host races us,
/// the daemon's lock file lets only one of them run.
fn spawn_daemon(dir: &Path) -> io::Result<()> {
    let state = paths::state_dir(dir);
    std::fs::create_dir_all(&state)?;
    let log = OpenOptions::new()
        .create(true)
        .append(true)
        .open(state.join("daemon.log"))?;
    Command::new(std::env::current_exe()?)
        .arg("daemon")
        .arg("--dir")
        .arg(dir)
        .stdin(Stdio::null())
        .stdout(log.try_clone()?)
        .stderr(log)
        .process_group(0)
        .spawn()?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Native messaging framing

fn receive(r: &mut impl Read) -> io::Result<Option<Value>> {
    let mut len = [0u8; 4];
    match r.read_exact(&mut len) {
        Ok(()) => {}
        Err(e) if e.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(e) => return Err(e),
    }
    let mut buf = vec![0u8; u32::from_ne_bytes(len) as usize];
    r.read_exact(&mut buf)?;
    serde_json::from_slice(&buf)
        .map(Some)
        .map_err(io::Error::other)
}

fn send(w: &mut impl Write, msg: &Value) -> io::Result<()> {
    let buf = serde_json::to_vec(msg)?;
    if buf.len() > MAX_OUTGOING {
        return Err(io::Error::other(format!(
            "message of {} bytes exceeds the native-messaging limit",
            buf.len()
        )));
    }
    w.write_all(&(buf.len() as u32).to_ne_bytes())?;
    w.write_all(&buf)?;
    w.flush()
}

// ---------------------------------------------------------------------------
// Log mode

/// Logs every message to `$XDG_STATE_HOME/atelier/native-host.log`, answers
/// `ping`, and otherwise does nothing. Used by the spikes.
fn log_mode(args: &[String], first: Value, mut stdin: impl Read) -> ExitCode {
    let mut stdout = io::stdout().lock();
    let mut log = Log::open();
    // Firefox passes the path to our manifest and the calling extension's ID.
    log.event(
        "connected",
        json!({ "pid": std::process::id(), "args": args }),
    );

    // A one-shot sendNativeMessage resolves with the first reply, so send one.
    let hello = wire::notification(
        "host/hello",
        json!({ "pid": std::process::id(), "startedAt": now_ms() }),
    );
    if let Err(e) = send(&mut stdout, &hello) {
        log.event("send-failed", json!({ "error": e.to_string() }));
        return ExitCode::FAILURE;
    }

    let mut next = Some(first);
    loop {
        let msg = match next.take() {
            Some(m) => m,
            None => match receive(&mut stdin) {
                Ok(Some(m)) => m,
                Ok(None) => {
                    log.event("disconnected", json!({}));
                    return ExitCode::SUCCESS;
                }
                Err(e) => {
                    log.event("receive-failed", json!({ "error": e.to_string() }));
                    return ExitCode::FAILURE;
                }
            },
        };
        log.event("received", msg.clone());

        // Notifications (no id) are only logged.
        let Some(id) = msg.get("id").cloned() else {
            continue;
        };
        let reply = match msg.get("method").and_then(Value::as_str) {
            Some("ping") => wire::response(id, json!({ "pong": now_ms() })),
            method => wire::error_response(
                id,
                wire::code::METHOD_NOT_FOUND,
                format!("method not found: {}", method.unwrap_or("(none)")),
            ),
        };
        if let Err(e) = send(&mut stdout, &reply) {
            log.event("send-failed", json!({ "error": e.to_string() }));
            return ExitCode::FAILURE;
        }
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64)
}

/// Append-only JSON-lines log. Logging is best-effort.
struct Log(Option<File>);

impl Log {
    fn open() -> Self {
        let dir: PathBuf = paths::state_root();
        let file = std::fs::create_dir_all(&dir).ok().and_then(|()| {
            OpenOptions::new()
                .create(true)
                .append(true)
                .open(dir.join("native-host.log"))
                .ok()
        });
        Log(file)
    }

    fn event(&mut self, event: &str, data: Value) {
        let line =
            json!({ "t": now_ms(), "pid": std::process::id(), "event": event, "data": data });
        if let Some(f) = &mut self.0 {
            let _ = writeln!(f, "{line}");
        }
    }
}
