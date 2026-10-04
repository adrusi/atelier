//! The wire protocol between atelier's processes (SPEC §4.1).
//!
//! Every hop speaks JSON-RPC 2.0: extension ↔ native host ↔ daemon ↔ (mcp,
//! cli). These are the method parameters and results, plus the bundle of
//! compiled styles the daemon serves. TypeScript bindings for the extension
//! are generated from these types: run `cargo test -p atelier-proto`, which
//! writes them to `extension/src/proto/`.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use ts_rs::TS;

/// Bumped on any incompatible change. Peers refuse to talk across versions.
pub const PROTOCOL_VERSION: u32 = 1;

/// Method names.
pub mod method {
    /// Request, first message on any connection: [`InitializeParams`] → [`InitializeResult`].
    pub const INITIALIZE: &str = "initialize";
    /// Request: [`SourceParams`] (optional) → [`BlobRef`] for that source's
    /// current [`Bundle`] (as JSON). Asking for a task's source starts the
    /// daemon watching its tree.
    pub const BUNDLE_GET: &str = "bundle/get";
    /// Notification from the daemon: [`BundleChanged`], a source's new bundle.
    pub const BUNDLE_CHANGED: &str = "bundle/changed";
    /// Request: [`BlobGetParams`] → [`BlobChunk`].
    pub const BLOB_GET: &str = "blob/get";
    /// Request: [`SourceParams`] (optional) → [`StatusResult`], with that
    /// source's bundle hash and diagnostics.
    pub const STATUS: &str = "status";
    /// Request from any client: [`BrowserCallParams`] → whatever the browser
    /// method returns. The daemon forwards the inner request to the most
    /// recently connected extension and relays its response (SPEC §10).
    pub const BROWSER_CALL: &str = "browser/call";
    /// Request: `{ "force"?: bool }` → `{ "started": bool, "command"?: …,
    /// "reason"?: … }`. Runs the configured session command (SPEC §9.1),
    /// unless a session is already working or starting (or `force`).
    pub const SESSION_START: &str = "session/start";
}

/// atelier-specific JSON-RPC error codes.
pub mod error_code {
    /// No extension is connected to the daemon, so browser tools can't run.
    pub const BROWSER_NOT_CONNECTED: i64 = -32010;
    /// The extension didn't answer a browser call in time.
    pub const BROWSER_TIMEOUT: i64 = -32011;
    /// A task operation was refused; the message says why.
    pub const TASK_REFUSED: i64 = -32030;
    /// A source that doesn't exist (now): no such task, or one that hasn't
    /// been claimed yet, or one that has finished.
    pub const NO_SUCH_SOURCE: i64 = -32031;
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct BrowserCallParams {
    /// The extension method, e.g. `tab/open` (extension/src/tools.ts).
    pub method: String,
    #[serde(default)]
    pub params: serde_json::Value,
    /// How long to wait for the browser, in milliseconds. Default 30000.
    #[ts(optional)]
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout_ms: Option<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "kebab-case")]
#[ts(export)]
pub enum Role {
    Extension,
    NativeHost,
    Mcp,
    Cli,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct InitializeParams {
    pub protocol_version: u32,
    pub role: Role,
    /// The owned directory this client wants. The native host uses it to pick
    /// (or start) the right daemon; a daemon rejects a client asking for a
    /// different directory. `None` means the default.
    #[ts(optional)]
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub atelier_dir: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct InitializeResult {
    pub protocol_version: u32,
    pub daemon_version: String,
    /// The canonical owned directory the daemon serves.
    pub atelier_dir: String,
}

/// A content-addressed blob, fetched in chunks with `blob/get`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct BlobRef {
    /// SHA-256 of the content, hex-encoded.
    pub hash: String,
    pub size: u64,
}

/// Which source (SPEC §6.2) a request is about.
#[derive(Debug, Clone, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SourceParams {
    /// A task's id, for its tree; absent for the owned directory.
    #[serde(default)]
    #[ts(optional)]
    pub source: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct BundleChanged {
    /// The task whose tree changed; absent for the owned directory.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub source: Option<String>,
    pub hash: String,
    pub size: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct BlobGetParams {
    pub hash: String,
    pub offset: u64,
    /// Requested length; the daemon may return less (it caps chunks so they fit
    /// native messaging's message-size limit).
    pub len: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct BlobChunk {
    /// Base64 of the bytes from `offset`.
    pub data: String,
    pub eof: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct StatusResult {
    pub atelier_dir: String,
    pub theme: Option<String>,
    pub styles: u32,
    pub clients: BTreeMap<String, u32>,
    pub diagnostics: Vec<Diagnostic>,
    /// The daemon has seen file changes it hasn't loaded yet; the bundle is
    /// about to change.
    pub reload_pending: bool,
    /// The current bundle's hash, to compare with what a client has loaded.
    pub bundle_hash: String,
}

// ---------------------------------------------------------------------------
// The bundle: everything the extension needs to apply styles.

/// Compiled styles for one source (SPEC §6.2), as served to the extension.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Bundle {
    /// The active theme, if `atelier.toml` names one.
    pub theme: Option<String>,
    pub styles: Vec<CompiledStyle>,
    /// Problems found while loading. Styles with errors are left out.
    pub diagnostics: Vec<Diagnostic>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct CompiledStyle {
    /// Path of the style file relative to the owned directory.
    pub id: String,
    /// The service it belongs to, or `None` for a theme-wide global style.
    pub service: Option<String>,
    pub name: String,
    /// `:root { --var: value; ... }` with values from vars.json, else defaults.
    pub vars_css: String,
    pub sections: Vec<CompiledSection>,
    /// WebExtension match patterns covering every section, for registering the
    /// style; the extension still checks each section's matchers precisely.
    pub patterns: Vec<String>,
    /// Site settings the style depends on (from its service's service.toml).
    pub prerequisites: Vec<Prerequisite>,
    /// Add `<meta name="darkreader-lock">` on pages where one of this style's
    /// sections with matchers applies (SPEC §6.5). Global sections never lock.
    pub dark_reader_lock: bool,
}

/// Something the user has to set on the site for a style to work (SPEC §5.2).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Prerequisite {
    /// What to do, for the user.
    pub description: String,
    /// A CSS selector that matches something in the page when the
    /// prerequisite is met, so pages can tell the user when it isn't.
    pub check: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct CompiledSection {
    /// Empty means the section applies everywhere the style does.
    pub matchers: Vec<Matcher>,
    pub css: String,
}

/// An `@-moz-document` matcher (SPEC §5.3).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", content = "value", rename_all = "kebab-case")]
#[ts(export)]
pub enum Matcher {
    Url(String),
    UrlPrefix(String),
    Domain(String),
    /// A JavaScript regular expression that must match the whole URL.
    Regexp(String),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Diagnostic {
    pub severity: Severity,
    /// Path relative to the owned directory, if the problem is in a file.
    pub path: Option<String>,
    pub line: Option<u32>,
    pub message: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export)]
pub enum Severity {
    Error,
    Warning,
}

// ---------------------------------------------------------------------------
// Tasks (SPEC §8).

pub mod task_method {
    /// [`TaskCreateParams`] → [`Task`].
    pub const CREATE: &str = "task/create";
    /// [`TaskListParams`] → `Vec<Task>`.
    pub const LIST: &str = "task/list";
    /// `{ "id": … }` → [`Task`].
    pub const GET: &str = "task/get";
    /// [`TaskClaimParams`] → [`Task`] (with `tree` set), or `null` if none is queued.
    pub const CLAIM: &str = "task/claim";
    /// `{ "id": …, "session": … }` → [`Task`]: extends the lease.
    pub const HEARTBEAT: &str = "task/heartbeat";
    /// [`TaskSubmitParams`] → [`SubmitResult`].
    pub const SUBMIT: &str = "task/submit";
    /// `{ "id": …, "reason": … }` → [`Task`].
    pub const DECLINE: &str = "task/decline";
    /// `{ "id": …, "reason": … }` → [`Task`]: the user (or supervisor) gives up on it.
    pub const ABANDON: &str = "task/abandon";
    /// `{ "id": …, "session": …, "handoff": … }` → [`Task`]: the session stops
    /// working on it for now. It goes back to the queue with its tree and the
    /// handoff note, for whoever claims it next.
    pub const RELEASE: &str = "task/release";
    /// `{ "id": … }` → `Vec<FileChange>`: how the task's tree differs from
    /// when it was claimed.
    pub const CHANGES: &str = "task/changes";
    /// Notification from the daemon: a [`Task`] changed.
    pub const CHANGED: &str = "task/changed";
    /// `{}` → `Vec<JournalEntry>`, newest first.
    pub const JOURNAL: &str = "journal/list";
    /// `{ "seq": … }` (default: the latest entry not yet undone) → [`JournalEntry`] for the undo.
    pub const UNDO: &str = "journal/undo";
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export)]
pub enum TaskKind {
    Create,
    Revise,
    Repair,
    Port,
    Audit,
    Notes,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export)]
pub enum TaskState {
    Queued,
    /// A session holds the lease and is working in the task's tree.
    Claimed,
    Landed,
    Declined,
    Abandoned,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct TaskBrief {
    /// What the user asked for, in their words.
    pub description: String,
    /// The page the request came from, if any.
    #[serde(default)]
    pub origin: Option<String>,
    /// Anything else: the user's note on a revise, failing checks on a repair.
    #[serde(default)]
    pub note: Option<String>,
    /// The Firefox container (cookieStoreId) the request came from.
    #[serde(default)]
    pub container: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Lease {
    pub session: String,
    /// Milliseconds since the epoch.
    pub expires: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "lowercase")]
#[ts(export)]
pub enum TaskOutcome {
    Landed {
        journal: u64,
        summary: String,
        assumptions: Vec<String>,
    },
    Declined {
        reason: String,
    },
    Abandoned {
        reason: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Task {
    pub id: String,
    pub kind: TaskKind,
    /// The service the task is about; for a create task, chosen when it lands.
    pub service: Option<String>,
    pub theme: Option<String>,
    pub brief: TaskBrief,
    pub state: TaskState,
    pub lease: Option<Lease>,
    /// The task's working copy of the owned directory, once claimed.
    pub tree: Option<String>,
    /// A note left by the last session to work on it, for whoever resumes it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub handoff: Option<String>,
    pub created: u64,
    pub updated: u64,
    pub outcome: Option<TaskOutcome>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct TaskCreateParams {
    pub kind: TaskKind,
    #[ts(optional)]
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub service: Option<String>,
    pub brief: TaskBrief,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct TaskListParams {
    /// Only tasks in this state; default all.
    #[ts(optional)]
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub state: Option<TaskState>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct TaskClaimParams {
    /// A specific task; default the oldest queued one.
    #[ts(optional)]
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    /// Who's claiming, for the lease.
    pub session: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct TaskSubmitParams {
    pub id: String,
    pub session: String,
    /// What changed and why, commit-message quality (SPEC §8.4).
    pub summary: String,
    #[serde(default)]
    pub assumptions: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "result", rename_all = "lowercase")]
#[ts(export)]
pub enum SubmitResult {
    Landed {
        journal: u64,
        changed: Vec<FileChange>,
    },
    /// Nothing was written. Fix the problems in the task's tree and submit again.
    Rejected { problems: Vec<SubmitProblem> },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct FileChange {
    pub path: String,
    pub change: ChangeKind,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export)]
pub enum ChangeKind {
    Added,
    Modified,
    Deleted,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SubmitProblem {
    /// `conflict`: the file changed in the owned directory since the task
    /// started; `outside`: the change is outside what the task may touch;
    /// `lint`: loading the task's tree reported an error; `empty`: nothing
    /// changed.
    pub kind: String,
    pub path: Option<String>,
    pub message: String,
    /// For a conflict: the file as it is now in the owned directory (absent
    /// if it was deleted), to reconcile with.
    pub current: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct JournalEntry {
    pub seq: u64,
    /// The task that landed, or for an undo, the task whose landing it undid.
    pub task: Option<String>,
    pub summary: String,
    pub time: u64,
    pub files: Vec<FileChange>,
    /// Set on a landing once it has been undone.
    pub undone_by: Option<u64>,
    /// Set on an undo entry: the landing it undid.
    pub undo_of: Option<u64>,
}
