//! The daemon (SPEC §4): one per owned directory.
//!
//! It loads the owned directory into a bundle, watches it (and vars.json) for
//! changes, and serves clients on a unix socket: the native host on behalf of
//! the extension, `atelier mcp`, and the CLI. A lock file next to the socket
//! makes sure only one daemon runs per directory. It exits after being idle
//! with no clients for a while (`ATELIER_DAEMON_IDLE_SECS`, default 600).

use crate::{loader, paths, wire};
use atelier_proto::{
    BlobChunk, BlobGetParams, BlobRef, Bundle, CompiledStyle, Diagnostic, InitializeParams,
    InitializeResult, PROTOCOL_VERSION, Role, Severity, StatusResult, method,
};
use base64::Engine;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::net::{UnixListener, UnixStream};
use tokio::sync::{broadcast, mpsc};

/// Raw bytes per `blob/get` chunk. Base64 grows it by a third, which keeps a
/// chunk's message comfortably under native messaging's 1 MB limit.
const CHUNK: u64 = 512 * 1024;
/// How many bundle versions to keep, so a client mid-download of an older one
/// can finish.
const KEEP_BLOBS: usize = 4;

pub fn run(dir: Option<&str>) -> ExitCode {
    let dir = match paths::resolve_dir(dir) {
        Ok(d) => d,
        Err(e) => {
            eprintln!("atelier daemon: {e}");
            return ExitCode::FAILURE;
        }
    };
    let rt = match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(rt) => rt,
        Err(e) => {
            eprintln!("atelier daemon: {e}");
            return ExitCode::FAILURE;
        }
    };
    match rt.block_on(serve(dir)) {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("atelier daemon: {e}");
            ExitCode::FAILURE
        }
    }
}

struct State {
    dir: PathBuf,
    inner: Mutex<Inner>,
    notify: broadcast::Sender<Value>,
}

struct Inner {
    bundle: Bundle,
    /// The last version of each style that loaded, so a save that breaks a
    /// style doesn't unstyle open pages while it's being fixed.
    last_good: BTreeMap<String, CompiledStyle>,
    bundle_ref: BlobRef,
    blobs: VecDeque<(String, Arc<Vec<u8>>)>,
    clients: BTreeMap<String, u32>,
    idle_since: Option<Instant>,
}

impl State {
    /// Reloads the bundle. Returns its new ref if it changed.
    fn reload(&self) -> Option<BlobRef> {
        let mut var_diags = Vec::new();
        let vars = read_vars(&mut var_diags);
        let mut bundle = loader::load(&self.dir, &vars);
        bundle.diagnostics.extend(var_diags);

        let mut inner = self.inner.lock().unwrap();
        keep_last_good(&mut bundle, &mut inner.last_good);
        let bytes = serde_json::to_vec(&bundle).expect("bundles serialize");
        let hash = hex(&Sha256::digest(&bytes));
        if inner.bundle_ref.hash == hash {
            return None;
        }
        log_changes(&inner.bundle, &bundle, &hash);
        let blob_ref = BlobRef {
            hash: hash.clone(),
            size: bytes.len() as u64,
        };
        inner.blobs.push_back((hash, Arc::new(bytes)));
        while inner.blobs.len() > KEEP_BLOBS {
            inner.blobs.pop_front();
        }
        inner.bundle = bundle;
        inner.bundle_ref = blob_ref.clone();
        Some(blob_ref)
    }
}

/// Puts back the last good version of any style that failed to load, with a
/// warning saying so, then remembers what's loaded now. Styles that are gone
/// without errors (deleted files, a different theme) are forgotten.
fn keep_last_good(bundle: &mut Bundle, last_good: &mut BTreeMap<String, CompiledStyle>) {
    let loaded: BTreeSet<String> = bundle.styles.iter().map(|s| s.id.clone()).collect();
    let broken: BTreeSet<String> = bundle
        .diagnostics
        .iter()
        .filter(|d| d.severity == Severity::Error)
        .filter_map(|d| d.path.clone())
        .filter(|p| p.ends_with(".user.css") && !loaded.contains(p))
        .collect();
    for id in broken {
        if let Some(old) = last_good.get(&id) {
            bundle.styles.push(old.clone());
            bundle.diagnostics.push(Diagnostic {
                severity: Severity::Warning,
                path: Some(id),
                line: None,
                message:
                    "still applying the last version that loaded, until the errors above are fixed"
                        .into(),
            });
        }
    }
    // The loader's order: theme-wide styles first, then services, each by path.
    bundle
        .styles
        .sort_by(|a, b| (a.service.is_some(), &a.id).cmp(&(b.service.is_some(), &b.id)));
    *last_good = bundle
        .styles
        .iter()
        .map(|s| (s.id.clone(), s.clone()))
        .collect();
}

/// Logs which styles changed and every diagnostic, so problems are visible in
/// daemon.log without asking.
fn log_changes(old: &Bundle, new: &Bundle, hash: &str) {
    let before: BTreeMap<&str, &CompiledStyle> =
        old.styles.iter().map(|s| (s.id.as_str(), s)).collect();
    let after: BTreeMap<&str, &CompiledStyle> =
        new.styles.iter().map(|s| (s.id.as_str(), s)).collect();
    let added: Vec<&str> = after
        .keys()
        .filter(|id| !before.contains_key(*id))
        .copied()
        .collect();
    let removed: Vec<&str> = before
        .keys()
        .filter(|id| !after.contains_key(*id))
        .copied()
        .collect();
    let changed: Vec<&str> = after
        .iter()
        .filter(|(id, s)| before.get(*id).is_some_and(|old| old != *s))
        .map(|(id, _)| *id)
        .collect();
    eprintln!(
        "atelier daemon: bundle {} ({} styles)",
        &hash[..12],
        new.styles.len()
    );
    for (label, ids) in [("added", added), ("changed", changed), ("removed", removed)] {
        for id in ids {
            eprintln!("  {label:<8} {id}");
        }
    }
    for d in &new.diagnostics {
        let severity = match d.severity {
            Severity::Error => "error",
            Severity::Warning => "warning",
        };
        let place = match (&d.path, d.line) {
            (Some(p), Some(l)) => format!("{p}:{l}: "),
            (Some(p), None) => format!("{p}: "),
            _ => String::new(),
        };
        eprintln!("  {severity:<8} {place}{}", d.message);
    }
}

/// Reads vars.json into strings, recording problems in `diags`. A missing
/// file means no overrides.
fn read_vars(diags: &mut Vec<Diagnostic>) -> BTreeMap<String, String> {
    let path = paths::vars_path();
    let text = match fs::read_to_string(&path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return BTreeMap::new(),
        Err(e) => {
            diags.push(vars_diag(&path, e.to_string()));
            return BTreeMap::new();
        }
    };
    match serde_json::from_str::<BTreeMap<String, Value>>(&text) {
        Ok(map) => map
            .into_iter()
            .filter_map(|(k, v)| match v {
                Value::String(s) => Some((k, s)),
                Value::Number(n) => Some((k, n.to_string())),
                Value::Bool(b) => Some((k, if b { "1" } else { "0" }.to_string())),
                _ => {
                    diags.push(vars_diag(
                        &path,
                        format!("`{k}` must be a string, number or boolean"),
                    ));
                    None
                }
            })
            .collect(),
        Err(e) => {
            diags.push(vars_diag(&path, e.to_string()));
            BTreeMap::new()
        }
    }
}

fn vars_diag(path: &Path, message: String) -> Diagnostic {
    Diagnostic {
        severity: Severity::Warning,
        path: None,
        line: None,
        message: format!("{}: {message}", path.display()),
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

async fn serve(dir: PathBuf) -> std::io::Result<()> {
    let socket = paths::socket_path(&dir);
    paths::check_socket_path(&socket)?;
    let runtime = socket.parent().expect("socket has a parent");
    fs::create_dir_all(runtime)?;
    fs::create_dir_all(paths::state_dir(&dir))?;

    // Holding this lock for our lifetime is what makes us the daemon for `dir`.
    let lock = fs::File::create(socket.with_extension("lock"))?;
    if lock.try_lock().is_err() {
        eprintln!("atelier daemon: already running for {}", dir.display());
        return Ok(());
    }
    let _ = fs::remove_file(&socket);
    let listener = UnixListener::bind(&socket)?;
    eprintln!(
        "atelier daemon: serving {} on {}",
        dir.display(),
        socket.display()
    );

    let (notify, _) = broadcast::channel(16);
    let state = Arc::new(State {
        dir: dir.clone(),
        inner: Mutex::new(Inner {
            bundle: Bundle::default(),
            bundle_ref: BlobRef {
                hash: String::new(),
                size: 0,
            },
            blobs: VecDeque::new(),
            last_good: BTreeMap::new(),
            clients: BTreeMap::new(),
            idle_since: Some(Instant::now()),
        }),
        notify,
    });
    state.reload();

    // Kept alive for as long as we serve.
    let _watcher = watch(state.clone())?;
    tokio::spawn(exit_when_idle(state.clone(), socket.clone()));

    loop {
        let (stream, _) = listener.accept().await?;
        tokio::spawn(handle(stream, state.clone()));
    }
}

/// Watches the owned directory and vars.json, reloading (debounced) on change.
fn watch(state: Arc<State>) -> std::io::Result<notify::RecommendedWatcher> {
    use notify::{RecursiveMode, Watcher};
    let (tx, mut rx) = mpsc::channel::<()>(64);
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        if res.is_ok_and(|e| !e.kind.is_access()) {
            let _ = tx.try_send(());
        }
    })
    .map_err(std::io::Error::other)?;
    watcher
        .watch(&state.dir, RecursiveMode::Recursive)
        .map_err(std::io::Error::other)?;
    let config = paths::config_dir();
    fs::create_dir_all(&config)?;
    watcher
        .watch(&config, RecursiveMode::NonRecursive)
        .map_err(std::io::Error::other)?;

    tokio::spawn(async move {
        while rx.recv().await.is_some() {
            // Let a burst of writes (an editor saving, a landing) settle.
            tokio::time::sleep(Duration::from_millis(150)).await;
            while rx.try_recv().is_ok() {}
            if let Some(blob_ref) = state.reload() {
                let _ = state
                    .notify
                    .send(wire::notification(method::BUNDLE_CHANGED, json!(blob_ref)));
            }
        }
    });
    Ok(watcher)
}

async fn exit_when_idle(state: Arc<State>, socket: PathBuf) {
    let idle = std::env::var("ATELIER_DAEMON_IDLE_SECS")
        .ok()
        .and_then(|s| s.parse().ok())
        .map_or(Duration::from_secs(600), Duration::from_secs);
    loop {
        tokio::time::sleep(Duration::from_secs(5).min(idle)).await;
        let since = state.inner.lock().unwrap().idle_since;
        if since.is_some_and(|t| t.elapsed() >= idle) {
            eprintln!("atelier daemon: idle for {}s, exiting", idle.as_secs());
            let _ = fs::remove_file(&socket);
            std::process::exit(0);
        }
    }
}

async fn handle(stream: UnixStream, state: Arc<State>) {
    let (mut reader, mut writer) = stream.into_split();

    // Read frames in their own task, so the main loop can wait on frames and
    // notifications at once without cancelling a half-read frame.
    let (frames_tx, mut frames) = mpsc::channel::<Value>(16);
    tokio::spawn(async move {
        while let Ok(Some(frame)) = wire::read_frame_async(&mut reader).await {
            if frames_tx.send(frame).await.is_err() {
                break;
            }
        }
    });

    let Some(first) = frames.recv().await else {
        return;
    };
    let role = match initialize(&state, &first) {
        Ok((role, reply)) => {
            if wire::write_frame_async(&mut writer, &reply).await.is_err() {
                return;
            }
            role
        }
        Err(reply) => {
            let _ = wire::write_frame_async(&mut writer, &reply).await;
            return;
        }
    };
    let role_name = serde_json::to_value(role)
        .unwrap()
        .as_str()
        .unwrap_or("?")
        .to_string();
    {
        let mut inner = state.inner.lock().unwrap();
        *inner.clients.entry(role_name.clone()).or_default() += 1;
        inner.idle_since = None;
    }

    let mut notifications = state.notify.subscribe();
    loop {
        let out = tokio::select! {
            frame = frames.recv() => match frame {
                Some(frame) => dispatch(&state, frame),
                None => break,
            },
            note = notifications.recv() => match note {
                Ok(note) => Some(note),
                Err(broadcast::error::RecvError::Lagged(_)) => continue,
                Err(broadcast::error::RecvError::Closed) => break,
            },
        };
        if let Some(out) = out
            && wire::write_frame_async(&mut writer, &out).await.is_err()
        {
            break;
        }
    }

    let mut inner = state.inner.lock().unwrap();
    if let Some(n) = inner.clients.get_mut(&role_name) {
        *n -= 1;
        if *n == 0 {
            inner.clients.remove(&role_name);
        }
    }
    if inner.clients.is_empty() {
        inner.idle_since = Some(Instant::now());
    }
}

fn initialize(state: &State, msg: &Value) -> Result<(Role, Value), Value> {
    let id = msg.get("id").cloned().unwrap_or(Value::Null);
    if msg.get("method").and_then(Value::as_str) != Some(method::INITIALIZE) {
        return Err(wire::error_response(
            id,
            wire::code::NOT_INITIALIZED,
            "send `initialize` first",
        ));
    }
    let params: InitializeParams =
        serde_json::from_value(msg.get("params").cloned().unwrap_or(Value::Null)).map_err(|e| {
            wire::error_response(id.clone(), wire::code::INVALID_PARAMS, e.to_string())
        })?;
    if params.protocol_version != PROTOCOL_VERSION {
        return Err(wire::error_response(
            id,
            wire::code::NOT_INITIALIZED,
            format!(
                "protocol version {} isn't supported; this daemon speaks {PROTOCOL_VERSION}",
                params.protocol_version
            ),
        ));
    }
    if let Some(asked) = &params.atelier_dir {
        let asked = Path::new(asked)
            .canonicalize()
            .unwrap_or_else(|_| PathBuf::from(asked));
        if asked != state.dir {
            return Err(wire::error_response(
                id,
                wire::code::INVALID_PARAMS,
                format!(
                    "this daemon serves {}, not {}",
                    state.dir.display(),
                    asked.display()
                ),
            ));
        }
    }
    let result = InitializeResult {
        protocol_version: PROTOCOL_VERSION,
        daemon_version: env!("CARGO_PKG_VERSION").to_string(),
        atelier_dir: state.dir.display().to_string(),
    };
    Ok((params.role, wire::response(id, json!(result))))
}

/// Handles one message after initialization. Returns the reply, if any.
fn dispatch(state: &State, msg: Value) -> Option<Value> {
    let id = msg.get("id").cloned()?; // notifications from clients need no reply
    let params = msg.get("params").cloned().unwrap_or(Value::Null);
    let reply = match msg.get("method").and_then(Value::as_str) {
        Some(method::BUNDLE_GET) => Ok(json!(state.inner.lock().unwrap().bundle_ref)),
        Some(method::BLOB_GET) => blob_get(state, params),
        Some(method::STATUS) => Ok(json!(status(state))),
        Some(m) => Err((
            wire::code::METHOD_NOT_FOUND,
            format!("unknown method `{m}`"),
        )),
        None => Err((wire::code::INVALID_REQUEST, "missing `method`".to_string())),
    };
    Some(match reply {
        Ok(result) => wire::response(id, result),
        Err((code, message)) => wire::error_response(id, code, message),
    })
}

fn blob_get(state: &State, params: Value) -> Result<Value, (i64, String)> {
    let p: BlobGetParams =
        serde_json::from_value(params).map_err(|e| (wire::code::INVALID_PARAMS, e.to_string()))?;
    let inner = state.inner.lock().unwrap();
    let blob = inner
        .blobs
        .iter()
        .find(|(h, _)| *h == p.hash)
        .map(|(_, b)| b.clone())
        .ok_or((wire::code::INVALID_PARAMS, format!("no blob {}", p.hash)))?;
    let start = (p.offset as usize).min(blob.len());
    let end = (start + p.len.min(CHUNK) as usize).min(blob.len());
    Ok(json!(BlobChunk {
        data: base64::engine::general_purpose::STANDARD.encode(&blob[start..end]),
        eof: end == blob.len(),
    }))
}

fn status(state: &State) -> StatusResult {
    let inner = state.inner.lock().unwrap();
    StatusResult {
        atelier_dir: state.dir.display().to_string(),
        theme: inner.bundle.theme.clone(),
        styles: inner.bundle.styles.len() as u32,
        clients: inner.clients.clone(),
        diagnostics: inner.bundle.diagnostics.clone(),
    }
}
