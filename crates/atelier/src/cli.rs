//! CLI commands (SPEC §13) that talk to the daemon or read the owned
//! directory directly.

use crate::{loader, paths, wire};
use atelier_proto::{
    Bundle, Diagnostic, InitializeParams, InitializeResult, PROTOCOL_VERSION, Role, Severity,
    StatusResult, method,
};
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::fs;
use std::io;
use std::os::unix::net::UnixStream;
use std::path::Path;
use std::process::ExitCode;

/// A synchronous JSON-RPC client for the daemon's socket.
pub struct Client {
    stream: UnixStream,
    next_id: u64,
}

impl Client {
    /// Connects to the daemon for `dir` and initializes. `None` if no daemon is running.
    pub fn connect(dir: &Path, role: Role) -> io::Result<Option<(Client, InitializeResult)>> {
        let socket = paths::socket_path(dir);
        paths::check_socket_path(&socket)?;
        let stream = match UnixStream::connect(&socket) {
            Ok(s) => s,
            Err(e)
                if matches!(
                    e.kind(),
                    io::ErrorKind::NotFound | io::ErrorKind::ConnectionRefused
                ) =>
            {
                return Ok(None);
            }
            Err(e) => return Err(e),
        };
        let mut client = Client { stream, next_id: 1 };
        let params = InitializeParams {
            protocol_version: PROTOCOL_VERSION,
            role,
            atelier_dir: Some(dir.display().to_string()),
        };
        let result = client.call(method::INITIALIZE, json!(params))?;
        Ok(Some((
            client,
            serde_json::from_value(result).map_err(io::Error::other)?,
        )))
    }

    pub fn call(&mut self, method: &str, params: Value) -> io::Result<Value> {
        let id = self.next_id;
        self.next_id += 1;
        wire::write_frame(&mut self.stream, &wire::request(id, method, params))?;
        loop {
            let msg = wire::read_frame(&mut self.stream)?
                .ok_or_else(|| io::Error::other("daemon closed the connection"))?;
            if msg.get("id") != Some(&json!(id)) {
                continue; // a notification
            }
            if let Some(err) = msg.get("error") {
                return Err(io::Error::other(
                    err.get("message")
                        .and_then(Value::as_str)
                        .unwrap_or("error")
                        .to_string(),
                ));
            }
            return Ok(msg.get("result").cloned().unwrap_or(Value::Null));
        }
    }
}

pub fn status(dir: Option<&str>) -> ExitCode {
    let dir = match paths::resolve_dir(dir) {
        Ok(d) => d,
        Err(e) => return fail(e),
    };
    println!("owned directory  {}", dir.display());
    println!("socket           {}", paths::socket_path(&dir).display());
    match Client::connect(&dir, Role::Cli) {
        Ok(Some((mut client, init))) => {
            let status: StatusResult = match client
                .call(method::STATUS, Value::Null)
                .and_then(|v| serde_json::from_value(v).map_err(io::Error::other))
            {
                Ok(s) => s,
                Err(e) => return fail(e),
            };
            println!("daemon           running (version {})", init.daemon_version);
            let clients: Vec<String> = status
                .clients
                .iter()
                .map(|(role, n)| format!("{role} ×{n}"))
                .collect();
            println!(
                "clients          {}",
                if clients.is_empty() {
                    "none".into()
                } else {
                    clients.join(", ")
                }
            );
            println!(
                "theme            {}",
                status.theme.as_deref().unwrap_or("(none)")
            );
            println!("styles           {}", status.styles);
            print_diagnostics(&status.diagnostics);
            ExitCode::SUCCESS
        }
        Ok(None) => {
            println!("daemon           not running");
            let bundle = load_directly(&dir);
            println!(
                "theme            {}",
                bundle.theme.as_deref().unwrap_or("(none)")
            );
            println!("styles           {}", bundle.styles.len());
            print_diagnostics(&bundle.diagnostics);
            ExitCode::SUCCESS
        }
        Err(e) => fail(e),
    }
}

/// Loads and checks the owned directory without the daemon.
pub fn lint(dir: Option<&str>) -> ExitCode {
    let dir = match paths::resolve_dir(dir) {
        Ok(d) => d,
        Err(e) => return fail(e),
    };
    let bundle = load_directly(&dir);
    for style in &bundle.styles {
        let scope = if style.patterns.iter().any(|p| p == "<all_urls>") {
            "all sites".to_string()
        } else {
            style.patterns.join(" ")
        };
        println!("ok     {}  ({scope})", style.id);
    }
    print_diagnostics(&bundle.diagnostics);
    if bundle
        .diagnostics
        .iter()
        .any(|d| d.severity == Severity::Error)
    {
        ExitCode::FAILURE
    } else {
        ExitCode::SUCCESS
    }
}

fn load_directly(dir: &Path) -> Bundle {
    let vars: BTreeMap<String, String> = fs::read_to_string(paths::vars_path())
        .ok()
        .and_then(|t| serde_json::from_str::<BTreeMap<String, Value>>(&t).ok())
        .map(|m| {
            m.into_iter()
                .filter_map(|(k, v)| match v {
                    Value::String(s) => Some((k, s)),
                    Value::Number(n) => Some((k, n.to_string())),
                    _ => None,
                })
                .collect()
        })
        .unwrap_or_default();
    loader::load(dir, &vars)
}

fn print_diagnostics(diags: &[Diagnostic]) {
    for d in diags {
        let severity = match d.severity {
            Severity::Error => "error",
            Severity::Warning => "warn ",
        };
        let place = match (&d.path, d.line) {
            (Some(p), Some(l)) => format!("{p}:{l}: "),
            (Some(p), None) => format!("{p}: "),
            _ => String::new(),
        };
        println!("{severity}  {place}{}", d.message);
    }
}

const THEME_TEMPLATE: &str = "\
# {name}

<!-- This is the brief agents work from when they style a service for this
theme. Write it for a designer who has never seen your desktop: what you're
going for, and why. Reference images can go in refs/. -->

## Vision

## Visual language

<!-- Density, shape (radii, borders, shadows), hierarchy, motion. -->

## Colour

<!-- A fixed palette, or the @var names styles should use and how far agents
should go to make them work across colour schemes (SPEC §5.4). -->

## Typography

## Things to avoid
";

pub fn init(dir: Option<&str>, theme: &str) -> ExitCode {
    let dir = paths::atelier_dir(dir);
    let theme_dir = dir.join("themes").join(theme);
    let mut created = Vec::new();
    let result = (|| -> io::Result<()> {
        fs::create_dir_all(dir.join("services"))?;
        fs::create_dir_all(theme_dir.join("refs"))?;
        fs::create_dir_all(theme_dir.join("global"))?;
        for (path, content) in [
            (
                dir.join("atelier.toml"),
                format!("theme = {}\n", toml_string(theme)),
            ),
            (
                theme_dir.join("THEME.md"),
                THEME_TEMPLATE.replace("{name}", theme),
            ),
            (
                theme_dir.join("notes.md"),
                format!(
                    "# Design notes for {theme}\n\n<!-- Maintained by the supervisor agent (SPEC §9.3). -->\n"
                ),
            ),
        ] {
            if !path.exists() {
                fs::write(&path, content)?;
                created.push(path);
            }
        }
        Ok(())
    })();
    if let Err(e) = result {
        return fail(e);
    }
    println!("owned directory {}", dir.display());
    if created.is_empty() {
        println!("everything already exists; nothing changed");
    }
    for p in created {
        println!("created {}", p.strip_prefix(&dir).unwrap_or(&p).display());
    }
    ExitCode::SUCCESS
}

fn toml_string(s: &str) -> String {
    toml::Value::String(s.to_string()).to_string()
}

fn fail(e: impl std::fmt::Display) -> ExitCode {
    eprintln!("atelier: {e}");
    ExitCode::FAILURE
}

/// Lists the styles that apply to `url`, and which of their sections apply and why.
pub fn match_url(dir: Option<&str>, url: &str) -> ExitCode {
    if !url.contains("://") {
        return fail(format!(
            "`{url}` isn't a URL; give the full address, e.g. https://{url}/"
        ));
    }
    let dir = match paths::resolve_dir(dir) {
        Ok(d) => d,
        Err(e) => return fail(e),
    };
    let bundle = load_directly(&dir);
    let mut any = false;
    for style in &bundle.styles {
        let reasons: Vec<String> = style
            .sections
            .iter()
            .enumerate()
            .filter_map(|(i, s)| {
                if s.matchers.is_empty() {
                    return Some(format!(
                        "section {i}: no @-moz-document block (applies everywhere)"
                    ));
                }
                let hits: Vec<String> = s
                    .matchers
                    .iter()
                    .filter(|m| crate::usercss::Matcher::from(*m).matches(url))
                    .map(describe_matcher)
                    .collect();
                (!hits.is_empty()).then(|| format!("section {i}: {}", hits.join(", ")))
            })
            .collect();
        if !reasons.is_empty() {
            any = true;
            println!("{}", style.id);
            for r in reasons {
                println!("  {r}");
            }
        }
    }
    if !any {
        println!("no styles apply to {url}");
    }
    ExitCode::SUCCESS
}

fn describe_matcher(m: &atelier_proto::Matcher) -> String {
    use atelier_proto::Matcher::*;
    match m {
        Url(v) => format!("url(\"{v}\")"),
        UrlPrefix(v) => format!("url-prefix(\"{v}\")"),
        Domain(v) => format!("domain(\"{v}\")"),
        Regexp(v) => format!("regexp(\"{v}\")"),
    }
}
