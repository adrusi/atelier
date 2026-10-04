//! The daemon (SPEC §4): one per owned directory.
//!
//! It loads the owned directory into a bundle, watches it (and vars.json) for
//! changes, and serves clients on a unix socket: the native host on behalf of
//! the extension, `atelier mcp`, and the CLI. A lock file next to the socket
//! makes sure only one daemon runs per directory. It exits after being idle
//! with no clients for a while (`ATELIER_DAEMON_IDLE_SECS`, default 600).

use crate::{loader, paths, session, tasks, wire};
use atelier_proto::{
    BlobChunk, BlobGetParams, BlobRef, BrowserCallParams, Bundle, BundleChanged, CompiledStyle,
    Diagnostic, InitializeParams, InitializeResult, PROTOCOL_VERSION, Role, Severity, SourceParams,
    StatusResult, error_code, method,
};
use base64::Engine;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet, HashMap, VecDeque};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::net::{UnixListener, UnixStream};
use tokio::sync::{broadcast, mpsc, oneshot};

/// Raw bytes per `blob/get` chunk. Base64 grows it by a third, which keeps a
/// chunk's message comfortably under native messaging's 1 MB limit.
const CHUNK: u64 = 512 * 1024;
/// How many superseded bundle versions to keep, so a client mid-download of
/// one can finish.
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
    /// Connected extensions, most recent last. Browser calls go to the last.
    browsers: Mutex<Vec<(u64, mpsc::Sender<BrowserRequest>)>>,
    next_link: AtomicU64,
    /// Set when the watcher sees a change, cleared once it's been loaded.
    reload_pending: AtomicBool,
    /// Whether to start an agent session when work arrives (SPEC §9.1).
    launcher: Mutex<session::Launcher>,
    /// Tasks and the journal (SPEC §8). The lock serialises task operations,
    /// which read and write the owned directory and the state directory.
    tasks: Mutex<tasks::Store>,
}

/// A request for the extension, and where to send its result.
struct BrowserRequest {
    method: String,
    params: Value,
    reply: oneshot::Sender<RpcResult>,
}

type RpcResult = Result<Value, (i64, String)>;

struct Inner {
    /// The owned directory's bundle: what the user's tabs get.
    default: Loaded,
    /// Task trees that agent tabs are bound to (SPEC §6.2), by task id. A
    /// tree is loaded and watched from the first `bundle/get` for it until
    /// its task finishes.
    sources: BTreeMap<String, Loaded>,
    blobs: VecDeque<(String, Arc<Vec<u8>>)>,
    clients: BTreeMap<String, u32>,
    idle_since: Option<Instant>,
}

/// One source's loaded bundle.
struct Loaded {
    dir: PathBuf,
    bundle: Bundle,
    /// The last version of each style that loaded, so a save that breaks a
    /// style doesn't unstyle open pages while it's being fixed.
    last_good: BTreeMap<String, CompiledStyle>,
    bundle_ref: BlobRef,
}

impl Loaded {
    fn new(dir: PathBuf) -> Loaded {
        Loaded {
            dir,
            bundle: Bundle::default(),
            last_good: BTreeMap::new(),
            bundle_ref: BlobRef {
                hash: String::new(),
                size: 0,
            },
        }
    }
}

impl Inner {
    fn loaded(&self, source: Option<&str>) -> Option<&Loaded> {
        match source {
            None => Some(&self.default),
            Some(id) => self.sources.get(id),
        }
    }
}

impl State {
    /// Reloads a source's bundle: the owned directory's, or a task tree's
    /// that's already being watched. Returns its new ref if it changed.
    fn reload(&self, source: Option<&str>) -> Option<BlobRef> {
        let dir = self.inner.lock().unwrap().loaded(source)?.dir.clone();
        let mut var_diags = Vec::new();
        let vars = read_vars(&mut var_diags);
        let mut bundle = loader::load(&dir, &vars);
        bundle.diagnostics.extend(var_diags);

        let mut guard = self.inner.lock().unwrap();
        let inner = &mut *guard;
        let loaded = match source {
            None => &mut inner.default,
            Some(id) => inner.sources.get_mut(id)?,
        };
        keep_last_good(&mut bundle, &mut loaded.last_good);
        let bytes = serde_json::to_vec(&bundle).expect("bundles serialize");
        let hash = hex(&Sha256::digest(&bytes));
        if loaded.bundle_ref.hash == hash {
            return None;
        }
        log_changes(source, &loaded.bundle, &bundle, &hash);
        let blob_ref = BlobRef {
            hash: hash.clone(),
            size: bytes.len() as u64,
        };
        loaded.bundle = bundle;
        loaded.bundle_ref = blob_ref.clone();
        inner.blobs.push_back((hash, Arc::new(bytes)));
        // Keep every source's current bundle, and a few older ones so a
        // client mid-download of one can finish.
        let current: BTreeSet<String> = std::iter::once(&inner.default)
            .chain(inner.sources.values())
            .map(|l| l.bundle_ref.hash.clone())
            .collect();
        let mut old = inner
            .blobs
            .iter()
            .filter(|(h, _)| !current.contains(h))
            .count();
        inner.blobs.retain(|(h, _)| {
            if old > KEEP_BLOBS && !current.contains(h) {
                old -= 1;
                return false;
            }
            true
        });
        Some(blob_ref)
    }

    /// Starts serving a task's tree as a source, if it isn't already, and
    /// returns its bundle's ref.
    fn open_source(&self, id: &str) -> Result<BlobRef, (i64, String)> {
        if let Some(l) = self.inner.lock().unwrap().sources.get(id) {
            return Ok(l.bundle_ref.clone());
        }
        let task = self
            .tasks
            .lock()
            .unwrap()
            .get(id)
            .map_err(|e| (error_code::NO_SUCH_SOURCE, e))?;
        let tree = match (&task.state, &task.tree) {
            (atelier_proto::TaskState::Claimed | atelier_proto::TaskState::Queued, Some(t)) => {
                PathBuf::from(t)
            }
            (atelier_proto::TaskState::Queued, None) => {
                return Err((
                    error_code::NO_SUCH_SOURCE,
                    format!("task {id} hasn't been claimed yet, so it has no tree to show"),
                ));
            }
            (state, _) => {
                return Err((
                    error_code::NO_SUCH_SOURCE,
                    format!("task {id} has finished ({state:?}), so its tree is no longer served"),
                ));
            }
        };
        self.inner
            .lock()
            .unwrap()
            .sources
            .entry(id.to_string())
            .or_insert_with(|| Loaded::new(tree));
        self.reload(Some(id));
        let inner = self.inner.lock().unwrap();
        Ok(inner.sources[id].bundle_ref.clone())
    }

    /// Stops serving a finished task's tree.
    fn close_source(&self, id: &str) {
        if self.inner.lock().unwrap().sources.remove(id).is_some() {
            eprintln!("atelier daemon: stopped serving task {id}'s tree");
        }
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
fn log_changes(source: Option<&str>, old: &Bundle, new: &Bundle, hash: &str) {
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
    let source = source.map_or(String::new(), |id| format!(" for task {id}"));
    eprintln!(
        "atelier daemon: bundle {}{source} ({} styles)",
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
            default: Loaded::new(dir.clone()),
            sources: BTreeMap::new(),
            blobs: VecDeque::new(),
            clients: BTreeMap::new(),
            idle_since: Some(Instant::now()),
        }),
        notify,
        browsers: Mutex::new(Vec::new()),
        next_link: AtomicU64::new(1),
        reload_pending: AtomicBool::new(false),
        tasks: Mutex::new(tasks::Store::new(&dir, &paths::state_dir(&dir))?),
        launcher: Mutex::new(session::Launcher::default()),
    });
    state.reload(None);

    // Kept alive for as long as we serve.
    let _watcher = watch(state.clone())?;
    tokio::spawn(exit_when_idle(state.clone(), socket.clone()));

    loop {
        let (stream, _) = listener.accept().await?;
        tokio::spawn(handle(stream, state.clone()));
    }
}

/// What a file change means for the bundles.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
enum Dirty {
    /// The owned directory.
    Default,
    /// A watched task tree.
    Source(String),
    /// vars.json: every source.
    All,
}

/// Watches the owned directory, task trees and vars.json, reloading
/// (debounced) whatever a change affects.
fn watch(state: Arc<State>) -> std::io::Result<notify::RecommendedWatcher> {
    use notify::{RecursiveMode, Watcher};
    let (tx, mut rx) = mpsc::channel::<Dirty>(256);
    let seen = state.clone();
    let config = paths::config_dir();
    fs::create_dir_all(&config)?;
    // Event paths are canonical, so these must be too.
    let config = config.canonicalize()?;
    let tasks_dir = paths::state_dir(&state.dir).join("tasks").canonicalize()?;
    let (config_w, tasks_w) = (config.clone(), tasks_dir.clone());
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        let Ok(event) = res else { return };
        if event.kind.is_access() {
            return;
        }
        for dirty in classify(&seen, &event.paths, &config_w, &tasks_w) {
            seen.reload_pending.store(true, Ordering::SeqCst);
            let _ = tx.try_send(dirty);
        }
    })
    .map_err(std::io::Error::other)?;
    watcher
        .watch(&state.dir, RecursiveMode::Recursive)
        .map_err(std::io::Error::other)?;
    watcher
        .watch(&config, RecursiveMode::NonRecursive)
        .map_err(std::io::Error::other)?;
    // Created by the task store.
    watcher
        .watch(&tasks_dir, RecursiveMode::Recursive)
        .map_err(std::io::Error::other)?;

    tokio::spawn(async move {
        while let Some(first) = rx.recv().await {
            // Let a burst of writes (an editor saving, a landing) settle.
            tokio::time::sleep(Duration::from_millis(150)).await;
            let mut dirty = BTreeSet::from([first]);
            while let Ok(d) = rx.try_recv() {
                dirty.insert(d);
            }
            // Cleared before loading, so a change during the load sets it again.
            state.reload_pending.store(false, Ordering::SeqCst);
            let mut sources: BTreeSet<Option<String>> = BTreeSet::new();
            for d in dirty {
                match d {
                    Dirty::Default => {
                        sources.insert(None);
                    }
                    Dirty::Source(id) => {
                        sources.insert(Some(id));
                    }
                    Dirty::All => {
                        sources.insert(None);
                        let ids: Vec<String> = state
                            .inner
                            .lock()
                            .unwrap()
                            .sources
                            .keys()
                            .cloned()
                            .collect();
                        sources.extend(ids.into_iter().map(Some));
                    }
                }
            }
            for source in sources {
                if let Some(blob) = state.reload(source.as_deref()) {
                    let changed = BundleChanged {
                        source,
                        hash: blob.hash,
                        size: blob.size,
                    };
                    let _ = state
                        .notify
                        .send(wire::notification(method::BUNDLE_CHANGED, json!(changed)));
                }
            }
        }
    });
    Ok(watcher)
}

/// Which bundles a change to these paths affects. Changes in task
/// directories only count inside the tree of a task being served.
fn classify(state: &State, changed: &[PathBuf], config: &Path, tasks: &Path) -> Vec<Dirty> {
    let mut dirty = Vec::new();
    for path in changed {
        let d = if path.starts_with(config) {
            Dirty::All
        } else if let Ok(rest) = path.strip_prefix(tasks) {
            let mut parts = rest.components();
            let (Some(id), Some(tree)) = (parts.next(), parts.next()) else {
                continue;
            };
            let id = id.as_os_str().to_string_lossy().into_owned();
            if tree.as_os_str() != "tree" || !state.inner.lock().unwrap().sources.contains_key(&id)
            {
                continue;
            }
            Dirty::Source(id)
        } else {
            Dirty::Default
        };
        if !dirty.contains(&d) {
            dirty.push(d);
        }
    }
    dirty
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

    // Everything this connection sends goes through `out`, so replies can be
    // produced later (browser calls) without holding up the loop.
    let (out, mut outgoing) = mpsc::channel::<Value>(32);
    // Extensions also take requests from the daemon.
    let (requests_tx, mut requests) = mpsc::channel::<BrowserRequest>(16);
    let link = (role == Role::Extension).then(|| {
        let id = state.next_link.fetch_add(1, Ordering::Relaxed);
        state
            .browsers
            .lock()
            .unwrap()
            .push((id, requests_tx.clone()));
        id
    });
    drop(requests_tx);
    let mut pending: HashMap<String, oneshot::Sender<RpcResult>> = HashMap::new();
    let mut next_request = 0u64;

    let mut notifications = state.notify.subscribe();
    loop {
        let frame = tokio::select! {
            frame = frames.recv() => match frame {
                Some(frame) => {
                    if frame.get("method").is_none() {
                        // A response to one of our requests to this extension.
                        let id = frame.get("id").and_then(Value::as_str).unwrap_or_default();
                        if let Some(reply) = pending.remove(id) {
                            let _ = reply.send(rpc_result(&frame));
                        }
                    } else {
                        handle_request(&state, frame, out.clone(), role);
                    }
                    continue;
                }
                None => break,
            },
            note = notifications.recv() => match note {
                Ok(note) => note,
                Err(broadcast::error::RecvError::Lagged(_)) => continue,
                Err(broadcast::error::RecvError::Closed) => break,
            },
            Some(frame) = outgoing.recv() => frame,
            Some(request) = requests.recv() => {
                next_request += 1;
                let id = format!("d{next_request}");
                pending.insert(id.clone(), request.reply);
                json!({ "jsonrpc": "2.0", "id": id, "method": request.method, "params": request.params })
            }
        };
        if wire::write_frame_async(&mut writer, &frame).await.is_err() {
            break;
        }
    }

    if let Some(link) = link {
        state.browsers.lock().unwrap().retain(|(id, _)| *id != link);
    }
    for (_, reply) in pending {
        let _ = reply.send(Err((
            error_code::BROWSER_NOT_CONNECTED,
            "the browser disconnected".into(),
        )));
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

/// Handles a request or notification from a client, sending any reply to `out`.
fn handle_request(state: &Arc<State>, msg: Value, out: mpsc::Sender<Value>, role: Role) {
    if msg.get("method").and_then(Value::as_str) == Some(method::BROWSER_CALL) {
        let Some(id) = msg.get("id").cloned() else {
            return;
        };
        let state = state.clone();
        tokio::spawn(async move {
            let reply =
                match browser_call(&state, msg.get("params").cloned().unwrap_or(Value::Null)).await
                {
                    Ok(result) => wire::response(id, result),
                    Err((code, message)) => wire::error_response(id, code, message),
                };
            let _ = out.send(reply).await;
        });
        return;
    }
    if let Some(reply) = dispatch(state, msg, role) {
        let _ = out.try_send(reply);
    }
}

/// Forwards a call to the most recently connected extension.
async fn browser_call(state: &State, params: Value) -> RpcResult {
    let p: BrowserCallParams =
        serde_json::from_value(params).map_err(|e| (wire::code::INVALID_PARAMS, e.to_string()))?;
    let link = state
        .browsers
        .lock()
        .unwrap()
        .last()
        .map(|(_, tx)| tx.clone());
    let link = link.ok_or((
        error_code::BROWSER_NOT_CONNECTED,
        "no browser is connected to atelier's daemon: Firefox may not be running, or the atelier extension isn't installed or enabled there".to_string(),
    ))?;
    let (reply, result) = oneshot::channel();
    link.send(BrowserRequest {
        method: p.method.clone(),
        params: p.params,
        reply,
    })
    .await
    .map_err(|_| {
        (
            error_code::BROWSER_NOT_CONNECTED,
            "the browser disconnected".to_string(),
        )
    })?;
    let timeout = Duration::from_millis(p.timeout_ms.unwrap_or(30_000));
    match tokio::time::timeout(timeout, result).await {
        Ok(Ok(r)) => r,
        Ok(Err(_)) => Err((
            error_code::BROWSER_NOT_CONNECTED,
            "the browser disconnected".into(),
        )),
        Err(_) => Err((
            error_code::BROWSER_TIMEOUT,
            format!(
                "the browser didn't answer `{}` within {}s",
                p.method,
                timeout.as_secs()
            ),
        )),
    }
}

fn rpc_result(frame: &Value) -> RpcResult {
    match frame.get("error") {
        Some(e) => Err((
            e.get("code")
                .and_then(Value::as_i64)
                .unwrap_or(wire::code::INTERNAL),
            e.get("message")
                .and_then(Value::as_str)
                .unwrap_or("error")
                .to_string(),
        )),
        None => Ok(frame.get("result").cloned().unwrap_or(Value::Null)),
    }
}

/// Handles one synchronous request. Returns the reply, if any.
fn dispatch(state: &State, msg: Value, role: Role) -> Option<Value> {
    let id = msg.get("id").cloned()?; // notifications from clients need no reply
    let params = msg.get("params").cloned().unwrap_or(Value::Null);
    let reply = match msg.get("method").and_then(Value::as_str) {
        Some(method::BUNDLE_GET) => source_param(params).and_then(|source| match source {
            None => Ok(json!(state.inner.lock().unwrap().default.bundle_ref)),
            Some(id) => state.open_source(&id).map(|r| json!(r)),
        }),
        Some(method::BLOB_GET) => blob_get(state, params),
        Some(method::STATUS) => source_param(params)
            .and_then(|source| status(state, source.as_deref()))
            .map(|s| json!(s)),
        Some(method::SESSION_START) => {
            let in_progress = state
                .tasks
                .lock()
                .unwrap()
                .list(Some(atelier_proto::TaskState::Claimed), now_ms())
                .is_ok_and(|t| !t.is_empty());
            let force = params
                .get("force")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            Ok(start_session(state, None, in_progress, force))
        }
        Some(m) if m.starts_with("task/") || m.starts_with("journal/") => {
            task_call(state, m, params, role)
        }
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

/// Task and journal methods (SPEC §8). Each one that changes a task
/// announces it with `task/changed`.
fn task_call(
    state: &State,
    method_name: &str,
    params: Value,
    role: Role,
) -> Result<Value, (i64, String)> {
    use atelier_proto::{
        SubmitResult, TaskClaimParams, TaskCreateParams, TaskListParams, TaskSubmitParams,
        task_method as tm,
    };
    let bad = |e: serde_json::Error| (wire::code::INVALID_PARAMS, e.to_string());
    let failed = |e: String| (error_code::TASK_REFUSED, e);
    let str_param = |name: &str| -> Result<String, (i64, String)> {
        params
            .get(name)
            .and_then(Value::as_str)
            .map(str::to_string)
            .ok_or((wire::code::INVALID_PARAMS, format!("missing `{name}`")))
    };
    let now = now_ms();
    let store = state.tasks.lock().unwrap();
    let announce = |task: &atelier_proto::Task| {
        use atelier_proto::TaskState::{Abandoned, Declined, Landed};
        if matches!(task.state, Landed | Declined | Abandoned) {
            state.close_source(&task.id);
        }
        let _ = state
            .notify
            .send(wire::notification(tm::CHANGED, json!(task)));
    };
    match method_name {
        tm::CREATE => {
            let p: TaskCreateParams = serde_json::from_value(params).map_err(bad)?;
            let theme = state.inner.lock().unwrap().default.bundle.theme.clone();
            let task = store.create(p, theme, now).map_err(failed)?;
            announce(&task);
            // Work the user asked for may start a session (SPEC §9.1). Tasks
            // an agent creates are for that agent's own session.
            use atelier_proto::TaskKind::{Audit, Create, Port, Revise};
            if role != Role::Mcp && matches!(task.kind, Create | Revise | Port | Audit) {
                let in_progress = store
                    .list(Some(atelier_proto::TaskState::Claimed), now)
                    .is_ok_and(|t| !t.is_empty());
                start_session(state, Some(&task.id), in_progress, false);
            }
            Ok(json!(task))
        }
        tm::LIST => {
            let p: TaskListParams =
                serde_json::from_value(if params.is_null() { json!({}) } else { params })
                    .map_err(bad)?;
            Ok(json!(store.list(p.state, now).map_err(failed)?))
        }
        tm::GET => Ok(json!(store.get(&str_param("id")?).map_err(failed)?)),
        tm::CLAIM => {
            let p: TaskClaimParams = serde_json::from_value(params).map_err(bad)?;
            let task = store
                .claim(p.id.as_deref(), &p.session, now)
                .map_err(failed)?;
            let mut launcher = state.launcher.lock().unwrap();
            launcher.polled();
            if let Some(t) = &task {
                launcher.claimed();
                announce(t);
            }
            Ok(json!(task))
        }
        tm::HEARTBEAT => {
            let task = store
                .heartbeat(&str_param("id")?, &str_param("session")?, now)
                .map_err(failed)?;
            Ok(json!(task))
        }
        tm::SUBMIT => {
            let p: TaskSubmitParams = serde_json::from_value(params).map_err(bad)?;
            let vars = read_vars(&mut Vec::new());
            let (task, result) = store
                .submit(&p.id, &p.session, &p.summary, p.assumptions, &vars, now)
                .map_err(failed)?;
            if let SubmitResult::Landed { journal, changed } = &result {
                announce(&task);
                run_hook(state, "on_land", &task, *journal, &p.summary, changed);
            }
            Ok(json!(result))
        }
        tm::DECLINE => {
            let task = store
                .decline(
                    &str_param("id")?,
                    &str_param("session")?,
                    &str_param("reason")?,
                    now,
                )
                .map_err(failed)?;
            announce(&task);
            Ok(json!(task))
        }
        tm::ABANDON => {
            let reason = params
                .get("reason")
                .and_then(Value::as_str)
                .unwrap_or("abandoned")
                .to_string();
            let task = store
                .abandon(&str_param("id")?, &reason, now)
                .map_err(failed)?;
            announce(&task);
            Ok(json!(task))
        }
        tm::RELEASE => {
            let handoff = params
                .get("handoff")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            let task = store
                .release(&str_param("id")?, &str_param("session")?, &handoff, now)
                .map_err(failed)?;
            announce(&task);
            Ok(json!(task))
        }
        tm::CHANGES => Ok(json!(store.changes(&str_param("id")?).map_err(failed)?)),
        tm::JOURNAL => Ok(json!(store.journal().map_err(failed)?)),
        tm::UNDO => {
            let seq = params.get("seq").and_then(Value::as_u64);
            let entry = store.undo(seq, now).map_err(failed)?;
            let task = entry.task.as_deref().and_then(|id| store.get(id).ok());
            if let Some(task) = &task {
                run_hook(
                    state,
                    "on_undo",
                    task,
                    entry.seq,
                    &entry.summary,
                    &entry.files,
                );
            }
            Ok(json!(entry))
        }
        other => Err((
            wire::code::METHOD_NOT_FOUND,
            format!("unknown method `{other}`"),
        )),
    }
}

/// Runs a hook from config.toml's [hooks] table (SPEC §8.6), without waiting.
/// Failures are logged; they never undo a landing.
fn run_hook(
    state: &State,
    hook: &str,
    task: &atelier_proto::Task,
    seq: u64,
    summary: &str,
    changed: &[atelier_proto::FileChange],
) {
    let command = std::fs::read_to_string(paths::config_path())
        .ok()
        .and_then(|t| t.parse::<toml::Table>().ok())
        .and_then(|t| t.get("hooks")?.get(hook)?.as_str().map(str::to_string));
    let Some(command) = command else { return };
    let list = paths::state_dir(&state.dir).join(format!("hook-{seq}.changed"));
    let paths: Vec<u8> = changed
        .iter()
        .flat_map(|c| [c.path.as_bytes(), b"\0"].concat())
        .collect();
    if let Err(e) = std::fs::write(&list, paths) {
        eprintln!("atelier daemon: {hook}: {e}");
        return;
    }
    let kind = serde_json::to_value(task.kind)
        .ok()
        .and_then(|v| v.as_str().map(str::to_string))
        .unwrap_or_default();
    let child = std::process::Command::new("sh")
        .arg("-c")
        .arg(&command)
        .current_dir(&state.dir)
        .env("ATELIER_DIR", &state.dir)
        .env("ATELIER_TASK_ID", &task.id)
        .env("ATELIER_TASK_KIND", kind)
        .env("ATELIER_SERVICE", task.service.clone().unwrap_or_default())
        .env("ATELIER_JOURNAL_SEQ", seq.to_string())
        .env("ATELIER_CHANGED_FILE", &list)
        .stdin(std::process::Stdio::piped())
        .spawn();
    match child {
        Ok(mut child) => {
            use std::io::Write;
            if let Some(mut stdin) = child.stdin.take() {
                let _ = stdin.write_all(summary.as_bytes());
            }
            let hook = hook.to_string();
            std::thread::spawn(move || match child.wait() {
                Ok(s) if s.success() => {}
                Ok(s) => eprintln!("atelier daemon: {hook} hook failed ({s})"),
                Err(e) => eprintln!("atelier daemon: {hook} hook: {e}"),
            });
        }
        Err(e) => eprintln!("atelier daemon: {hook} hook: {e}"),
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64)
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

fn status(state: &State, source: Option<&str>) -> Result<StatusResult, (i64, String)> {
    if let Some(id) = source {
        state.open_source(id)?;
    }
    let inner = state.inner.lock().unwrap();
    let loaded = inner.loaded(source).ok_or((
        error_code::NO_SUCH_SOURCE,
        format!("task {} is no longer served", source.unwrap_or_default()),
    ))?;
    Ok(StatusResult {
        atelier_dir: state.dir.display().to_string(),
        theme: loaded.bundle.theme.clone(),
        styles: loaded.bundle.styles.len() as u32,
        clients: inner.clients.clone(),
        diagnostics: loaded.bundle.diagnostics.clone(),
        reload_pending: state.reload_pending.load(Ordering::SeqCst),
        bundle_hash: loaded.bundle_ref.hash.clone(),
    })
}

/// The `source` of a [`SourceParams`], which may be omitted altogether.
fn source_param(params: Value) -> Result<Option<String>, (i64, String)> {
    if params.is_null() {
        return Ok(None);
    }
    serde_json::from_value::<SourceParams>(params)
        .map(|p| p.source)
        .map_err(|e| (wire::code::INVALID_PARAMS, e.to_string()))
}

/// Starts an agent session with the user's command, unless one is already
/// at work or on its way (or `force`). Automatic starts only happen under
/// `start = "spawn"` or `"headless"`; `atelier session start` runs the
/// command whatever the mode. Returns what happened, which is also logged.
fn start_session(state: &State, task: Option<&str>, in_progress: bool, force: bool) -> Value {
    let manual = task.is_none();
    let config = match session::config() {
        Ok(c) => c,
        Err(e) => {
            eprintln!("atelier daemon: {e}");
            return json!({ "started": false, "reason": e });
        }
    };
    if !manual && config.start == session::Start::Pull {
        return json!({ "started": false, "reason": "sessions are started by hand (start = \"pull\")" });
    }
    let mut launcher = state.launcher.lock().unwrap();
    if !force && let Some(reason) = launcher.busy(in_progress) {
        eprintln!("atelier daemon: not starting a session: {reason}");
        return json!({ "started": false, "reason": reason });
    }
    match launcher.launch(&config, &state.dir, task) {
        Ok(line) => {
            eprintln!("atelier daemon: started a session: {line}");
            json!({ "started": true, "command": line })
        }
        Err(e) => {
            eprintln!("atelier daemon: couldn't start a session: {e}");
            json!({ "started": false, "reason": e })
        }
    }
}
