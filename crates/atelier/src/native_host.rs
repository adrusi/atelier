//! The native-messaging host (SPEC §4).
//!
//! For now this is a stub: there is no daemon to relay to yet. It speaks the
//! native-messaging framing (a 4-byte native-endian length, then UTF-8 JSON),
//! carries JSON-RPC 2.0 as proposed in SPEC §4.1, answers `ping`, and logs
//! every connection and message with a timestamp. The log is what spike R4
//! (does Firefox suspend the MV3 background while a native port is open?)
//! reads from.

use serde_json::{Value, json};
use std::fs::{File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::PathBuf;
use std::process::ExitCode;
use std::time::{SystemTime, UNIX_EPOCH};

/// Firefox rejects messages from the host larger than this.
const MAX_OUTGOING: usize = 1024 * 1024;

pub fn run(args: &[String]) -> ExitCode {
    // Firefox passes the path to our manifest and the calling extension's ID.
    let mut log = Log::open();
    log.event(
        "connected",
        json!({ "pid": std::process::id(), "args": args }),
    );

    let mut stdin = io::stdin().lock();
    let mut stdout = io::stdout().lock();

    let hello = json!({
        "jsonrpc": "2.0",
        "method": "host/hello",
        "params": { "pid": std::process::id(), "startedAt": now_ms() },
    });
    if let Err(e) = send(&mut stdout, &hello) {
        log.event("send-failed", json!({ "error": e.to_string() }));
        return ExitCode::FAILURE;
    }

    loop {
        let msg = match receive(&mut stdin) {
            Ok(Some(msg)) => msg,
            Ok(None) => {
                log.event("disconnected", json!({}));
                return ExitCode::SUCCESS;
            }
            Err(e) => {
                log.event("receive-failed", json!({ "error": e.to_string() }));
                return ExitCode::FAILURE;
            }
        };
        log.event("received", msg.clone());

        // Notifications (no id) are only logged.
        let Some(id) = msg.get("id").cloned() else {
            continue;
        };
        let reply = match msg.get("method").and_then(Value::as_str) {
            Some("ping") => json!({ "jsonrpc": "2.0", "id": id, "result": { "pong": now_ms() } }),
            method => json!({
                "jsonrpc": "2.0",
                "id": id,
                "error": { "code": -32601, "message": format!("method not found: {}", method.unwrap_or("(none)")) },
            }),
        };
        if let Err(e) = send(&mut stdout, &reply) {
            log.event("send-failed", json!({ "error": e.to_string() }));
            return ExitCode::FAILURE;
        }
    }
}

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

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64)
}

/// Append-only JSON-lines log in `$XDG_STATE_HOME/atelier/native-host.log`.
/// Logging is best-effort: a host that can't log still works.
struct Log(Option<File>);

impl Log {
    fn open() -> Self {
        let dir = std::env::var_os("XDG_STATE_HOME")
            .map(PathBuf::from)
            .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local/state")))
            .map(|d| d.join("atelier"));
        let file = dir.and_then(|dir| {
            std::fs::create_dir_all(&dir).ok()?;
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
