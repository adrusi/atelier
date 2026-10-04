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
    /// Request: no params → [`BlobRef`] for the current [`Bundle`] (as JSON).
    pub const BUNDLE_GET: &str = "bundle/get";
    /// Notification from the daemon: [`BlobRef`] for a new [`Bundle`].
    pub const BUNDLE_CHANGED: &str = "bundle/changed";
    /// Request: [`BlobGetParams`] → [`BlobChunk`].
    pub const BLOB_GET: &str = "blob/get";
    /// Request: no params → [`StatusResult`].
    pub const STATUS: &str = "status";
    /// Request from any client: [`BrowserCallParams`] → whatever the browser
    /// method returns. The daemon forwards the inner request to the most
    /// recently connected extension and relays its response (SPEC §10).
    pub const BROWSER_CALL: &str = "browser/call";
}

/// atelier-specific JSON-RPC error codes.
pub mod error_code {
    /// No extension is connected to the daemon, so browser tools can't run.
    pub const BROWSER_NOT_CONNECTED: i64 = -32010;
    /// The extension didn't answer a browser call in time.
    pub const BROWSER_TIMEOUT: i64 = -32011;
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
