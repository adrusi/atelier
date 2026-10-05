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
    /// Connects to the daemon for `dir`, starting it if it isn't running.
    pub fn connect_or_start(dir: &Path, role: Role) -> io::Result<Client> {
        let stream = crate::native_host::connect_or_spawn(dir)?;
        let mut client = Client { stream, next_id: 1 };
        let params = InitializeParams {
            protocol_version: PROTOCOL_VERSION,
            role,
            atelier_dir: Some(dir.display().to_string()),
        };
        client.call(method::INITIALIZE, json!(params))?;
        Ok(client)
    }

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
            let msg = wire::read_frame(&mut self.stream)?.ok_or_else(|| {
                io::Error::new(io::ErrorKind::UnexpectedEof, "daemon closed the connection")
            })?;
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

/// Calls a browser tool through the daemon (SPEC §10) and prints the result
/// as JSON. With `out`, a result carrying image `data` (base64) has it written
/// to that file instead.
pub fn browser(
    dir: Option<&str>,
    method: &str,
    params: Option<&str>,
    out: Option<&str>,
) -> ExitCode {
    let dir = match paths::resolve_dir(dir) {
        Ok(d) => d,
        Err(e) => return fail(e),
    };
    let params: Value = match params.map(serde_json::from_str).transpose() {
        Ok(p) => p.unwrap_or(Value::Null),
        Err(e) => return fail(format!("params aren't valid JSON: {e}")),
    };
    let mut client = match Client::connect(&dir, Role::Cli) {
        Ok(Some((c, _))) => c,
        Ok(None) => return fail(format!("no daemon is running for {}", dir.display())),
        Err(e) => return fail(e),
    };
    let mut result = match client.call(
        method::BROWSER_CALL,
        json!({ "method": method, "params": params }),
    ) {
        Ok(r) => r,
        Err(e) => return fail(e),
    };
    if let (Some(path), Some(data)) = (out, result.get("data").and_then(Value::as_str)) {
        use base64::Engine;
        let bytes = match base64::engine::general_purpose::STANDARD.decode(data) {
            Ok(b) => b,
            Err(e) => return fail(format!("result data isn't base64: {e}")),
        };
        if let Err(e) = fs::write(path, bytes) {
            return fail(e);
        }
        result["data"] = json!(format!("(written to {path})"));
    }
    println!(
        "{}",
        serde_json::to_string_pretty(&result).unwrap_or_default()
    );
    ExitCode::SUCCESS
}

/// `atelier task …`, `atelier undo`, `atelier journal` (SPEC §8, §13).
pub fn tasks(dir: Option<&str>, args: &[String]) -> ExitCode {
    use atelier_proto::task_method as tm;
    let dir = match paths::resolve_dir(dir) {
        Ok(d) => d,
        Err(e) => return fail(e),
    };
    let mut client = match Client::connect_or_start(&dir, Role::Cli) {
        Ok(c) => c,
        Err(e) => return fail(e),
    };
    let arg = |i: usize| args.get(i).map(String::as_str);
    let opt = |name: &str| {
        args.iter()
            .position(|a| a == name)
            .and_then(|i| args.get(i + 1))
            .cloned()
    };
    let result = match (arg(0), arg(1)) {
        (Some("task"), Some("create")) => {
            let Some(description) =
                args.iter()
                    .skip(2)
                    .filter(|a| !a.starts_with("--"))
                    .find(|a| {
                        // Skip option values.
                        !["--kind", "--service", "--origin", "--note"]
                            .iter()
                            .any(|o| opt(o).as_deref() == Some(a.as_str()))
                    })
            else {
                return fail(
                    "usage: atelier task create [--kind KIND] [--service S] [--origin URL] [--note TEXT] DESCRIPTION",
                );
            };
            client.call(
                tm::CREATE,
                json!({
                    "kind": opt("--kind").unwrap_or_else(|| "create".into()),
                    "service": opt("--service"),
                    "brief": { "description": description, "origin": opt("--origin"), "note": opt("--note") },
                }),
            )
        }
        (Some("task"), Some("list") | None) => client
            .call(tm::LIST, json!({ "state": opt("--state") }))
            .map(|v| {
                for t in v.as_array().into_iter().flatten() {
                    println!(
                        "{}  {:<9} {:<7} {:<14} {}",
                        t["id"].as_str().unwrap_or("?"),
                        t["state"].as_str().unwrap_or("?"),
                        t["kind"].as_str().unwrap_or("?"),
                        t["service"].as_str().unwrap_or("-"),
                        t["brief"]["description"].as_str().unwrap_or("")
                    );
                }
                Value::Null
            }),
        (Some("task"), Some("show")) => match arg(2) {
            Some(id) => client.call(tm::GET, json!({ "id": id })),
            None => return fail("usage: atelier task show ID"),
        },
        // Working a task by hand: claim it, edit its tree, submit.
        (Some("task"), Some("claim")) => client.call(
            tm::CLAIM,
            json!({
                "id": arg(2).filter(|a| !a.starts_with("--")),
                "session": opt("--session").unwrap_or_else(|| "cli".into()),
            }),
        ),
        (Some("task"), Some("submit")) => match (
            arg(2),
            args.get(3..).and_then(|rest| {
                rest.iter().find(|a| {
                    !a.starts_with("--") && opt("--session").as_deref() != Some(a.as_str())
                })
            }),
        ) {
            (Some(id), Some(summary)) => client.call(
                tm::SUBMIT,
                json!({
                    "id": id,
                    "session": opt("--session").unwrap_or_else(|| "cli".into()),
                    "summary": summary,
                }),
            ),
            _ => return fail("usage: atelier task submit ID [--session NAME] SUMMARY"),
        },
        (Some("task"), Some("abandon")) => match arg(2) {
            Some(id) => client.call(
                tm::ABANDON,
                json!({ "id": id, "reason": arg(3).unwrap_or("abandoned by the user") }),
            ),
            None => return fail("usage: atelier task abandon ID [REASON]"),
        },
        (Some("calls"), _) => client
            .call(atelier_proto::call_method::LIST, json!({ "open": true }))
            .map(|v| {
                for b in v.as_array().into_iter().flatten() {
                    println!(
                        "{}  {:<6}  {}",
                        b["id"].as_str().unwrap_or("?"),
                        b["wait"].as_str().unwrap_or("?"),
                        b["summary"].as_str().unwrap_or("")
                    );
                    for (i, c) in b["calls"].as_array().into_iter().flatten().enumerate() {
                        let choice = c["choice"]
                            .as_str()
                            .map(|c| format!("  [agent's call: {c}]"))
                            .unwrap_or_default();
                        println!(
                            "    {}. {}{choice}",
                            i + 1,
                            c["question"].as_str().unwrap_or("")
                        );
                    }
                }
                Value::Null
            }),
        // Answers as JSON, one per call in order: {"choice": …, "note": …};
        // calls left out keep the agent's choice.
        (Some("answer"), Some(batch)) => {
            let answers: Value = match arg(2).map(serde_json::from_str).transpose() {
                Ok(a) => a.unwrap_or(json!([])),
                Err(e) => return fail(format!("answers must be JSON: {e}")),
            };
            client.call(
                atelier_proto::call_method::ANSWER,
                json!({ "batch": batch, "answers": answers }),
            )
        }
        (Some("proposals"), _) => client
            .call(
                atelier_proto::theme_method::PROPOSALS,
                json!({ "open": true }),
            )
            .map(|v| {
                for p in v.as_array().into_iter().flatten() {
                    println!(
                        "{}  {}: {}",
                        p["id"].as_str().unwrap_or("?"),
                        p["path"].as_str().unwrap_or("?"),
                        p["summary"].as_str().unwrap_or("")
                    );
                }
                Value::Null
            }),
        (Some("decide"), Some(id)) => match arg(2) {
            Some(d @ ("accept" | "decline")) => client.call(
                atelier_proto::theme_method::DECIDE,
                json!({ "id": id, "accept": d == "accept", "note": arg(3) }),
            ),
            _ => return fail("usage: atelier decide PROPOSAL accept|decline [NOTE]"),
        },
        (Some("stage"), stage) => {
            client.call(atelier_proto::call_method::STAGE, json!({ "stage": stage }))
        }
        (Some("session"), Some("start")) => client.call(
            atelier_proto::method::SESSION_START,
            json!({ "force": args.iter().any(|a| a == "--force") }),
        ),
        (Some("undo"), seq) => client.call(
            tm::UNDO,
            json!({ "seq": seq.and_then(|s| s.parse::<u64>().ok()) }),
        ),
        (Some("journal"), _) => client.call(tm::JOURNAL, json!({})).map(|v| {
            for e in v.as_array().into_iter().flatten() {
                let flag = if e["undoneBy"].is_u64() {
                    " (undone)"
                } else {
                    ""
                };
                println!(
                    "{:>4}  {}{flag}",
                    e["seq"],
                    e["summary"].as_str().unwrap_or("")
                );
                for f in e["files"].as_array().into_iter().flatten() {
                    println!(
                        "        {:<8} {}",
                        f["change"].as_str().unwrap_or(""),
                        f["path"].as_str().unwrap_or("")
                    );
                }
            }
            Value::Null
        }),
        _ => {
            return fail(
                "usage: atelier task create|list|show|claim|submit|abandon …, atelier undo [SEQ], atelier journal, atelier session start [--force]",
            );
        }
    };
    match result {
        Ok(Value::Null) => ExitCode::SUCCESS,
        Ok(v) => {
            println!("{}", serde_json::to_string_pretty(&v).unwrap_or_default());
            ExitCode::SUCCESS
        }
        Err(e) => fail(e),
    }
}
