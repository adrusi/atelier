//! `atelier mcp`: the MCP server agents use to work in the browser (SPEC §10).
//!
//! It speaks MCP over stdio (newline-delimited JSON-RPC) and forwards tool
//! calls to the daemon as `browser/call`, which the daemon passes on to the
//! extension (extension/src/tools.ts). The tool descriptions are written for
//! the agents reading them; see PROMPTING.md and AGENT-EXPERIENCE.md before
//! changing them.

use crate::cli::Client;
use crate::paths;
use atelier_proto::{Role, method};
use serde_json::{Value, json};
use std::io::{self, BufRead, Write};
use std::path::PathBuf;
use std::process::ExitCode;

const PROTOCOL_VERSION: &str = "2025-06-18";

const INSTRUCTIONS: &str = "\
atelier applies userstyles from an owned directory of plain files (SPEC.md §5 in the atelier repo). \
These tools let you see and inspect pages in the user's browser while you write or fix styles. \
You work in agent tabs that you open with tab_open: background tabs in the user's Firefox, logged in \
wherever the user is. Inspection tools refuse the user's own tabs, so you can't disturb what they're doing. \
Style files are edited directly in the owned directory (styles_status shows where it is), and open pages \
pick up each save within a second, so the loop is: edit, then screenshot or inspect. \
A good first step on a new site is css_tokens: overriding a site's own design tokens usually restyles \
it far more thoroughly and robustly than restyling components one by one.";

struct Tool {
    name: &'static str,
    /// The extension method it calls.
    method: &'static str,
    description: &'static str,
    schema: fn() -> Value,
}

fn tab_prop() -> Value {
    json!({ "type": "integer", "description": "An agent tab's id, from tab_open or tab_list." })
}

const TOOLS: &[Tool] = &[
    Tool {
        name: "tab_open",
        method: "tab/open",
        description: "Open a URL in a new agent tab and wait for it to load. Agent tabs are background tabs in the user's \
            browser, so they share the user's logins, and the user isn't interrupted. Returns the tab's id, which the \
            other tools take. Close tabs you're finished with (tab_close).",
        schema: || json!({ "type": "object", "properties": { "url": { "type": "string" }, "waitFor": { "type": "string", "description": "For pages that render after load (JavaScript apps): also wait until this CSS selector matches, up to waitForMs (default 10000)." }, "waitForMs": { "type": "integer" } }, "required": ["url"] }),
    },
    Tool {
        name: "tab_navigate",
        method: "tab/navigate",
        description: "Load a URL in an existing agent tab and wait for it to load (and for waitFor, if given).",
        schema: || json!({ "type": "object", "properties": { "tab": tab_prop(), "url": { "type": "string" }, "waitFor": { "type": "string", "description": "For pages that render after load (JavaScript apps): also wait until this CSS selector matches, up to waitForMs (default 10000)." }, "waitForMs": { "type": "integer" } }, "required": ["tab", "url"] }),
    },
    Tool {
        name: "tab_reload",
        method: "tab/reload",
        description: "Reload an agent tab. You don't need this to see style edits (open pages update on save), \
            but it's how to check what a page looks like on first load.",
        schema: || json!({ "type": "object", "properties": { "tab": tab_prop() }, "required": ["tab"] }),
    },
    Tool {
        name: "tab_list",
        method: "tab/list",
        description: "List your agent tabs, with their URLs and load status.",
        schema: || json!({ "type": "object", "properties": {} }),
    },
    Tool {
        name: "tab_close",
        method: "tab/close",
        description: "Close an agent tab.",
        schema: || json!({ "type": "object", "properties": { "tab": tab_prop() }, "required": ["tab"] }),
    },
    Tool {
        name: "screenshot",
        method: "page/screenshot",
        description: "Capture an agent tab: the visible viewport by default, the whole page (fullPage, capped at \
            maxHeight pixels), or one element (selector). CSS animations are fast-forwarded first, so entrance \
            animations don't leave content invisible. Agent tabs are in the background, where Firefox doesn't run \
            animation frames, so content drawn by JavaScript animation (canvases) can be stale; the result says so \
            when it applies. Prefer selector captures for details: whole pages are large and hard to read. \
            With saveAs, the image is also written into the owned directory: that's how to leave the preview \
            screenshots each style keeps in its previews/ folder (SPEC.md §5.2). The image isn't sent back to you \
            then unless you ask (returnImage), since you've usually just looked at the page. Images on the page are \
            given a moment to load first. For small details, raise scale (e.g. 3).",
        schema: || {
            json!({ "type": "object", "properties": {
                "tab": tab_prop(),
                "selector": { "type": "string", "description": "Capture just the first element matching this CSS selector." },
                "fullPage": { "type": "boolean", "description": "Capture the whole page rather than the viewport." },
                "maxHeight": { "type": "integer", "description": "Height limit for fullPage, in CSS pixels. Default 4000." },
                "format": { "type": "string", "enum": ["png", "jpeg"], "description": "Default png." },
                "settleAnimations": { "type": "boolean", "description": "Fast-forward CSS animations first. Default true." },
                "scale": { "type": "number", "description": "Pixels per CSS pixel. Default 1; use 2–4 to inspect small elements." },
                "returnImage": { "type": "boolean", "description": "With saveAs: also return the image. Default false." },
                "saveAs": { "type": "string", "description": "Also save the image at this path, relative to the owned directory, e.g. services/example/roarke/previews/home.jpg. A .jpg name saves JPEG (smaller; preferred for previews)." }
            }, "required": ["tab"] })
        },
    },
    Tool {
        name: "css_tokens",
        method: "page/tokens",
        description: "Inventory the custom properties (design tokens) the page's stylesheets define, following \
            @import: each one's values, the selectors defining them, the conditions (media queries, layers, imports) \
            around them, and where it's used (how many declarations reference it, with example selectors; tokens \
            used by nothing are rarely worth overriding). \
            `otherScopes` lists selectors other than :root that define tokens, and the elements they match: those \
            nested scopes (e.g. a header marked as a dark theme region) re-declare tokens, which undoes :root \
            overrides inside them, so cover them too. Stylesheets the page can't read (cross-origin without CORS) \
            are listed as unreadable. Use `filter` (a substring of the name) on large design systems.",
        schema: || {
            json!({ "type": "object", "properties": {
                "tab": tab_prop(),
                "filter": { "type": "string", "description": "Only properties whose names contain this." },
                "limit": { "type": "integer", "description": "Maximum properties to list. Default 200." },
                "usage": { "type": "boolean", "description": "Include where each token is used. Default true." }
            }, "required": ["tab"] })
        },
    },
    Tool {
        name: "matched_rules",
        method: "page/matched_rules",
        description: "Explain an element's styling: every style rule that matches it (including atelier's, labelled), \
            most specific first, with specificity, enclosing media queries and layers, whether those conditions \
            hold now, and its declarations. Give `property` to see only rules setting it, plus its computed value. \
            This is how to find out why a rule of yours doesn't win: compare specificity, and remember that \
            unlayered rules beat layered ones regardless of specificity.",
        schema: || {
            json!({ "type": "object", "properties": {
                "tab": tab_prop(),
                "selector": { "type": "string", "description": "CSS selector; the first match is explained." },
                "property": { "type": "string", "description": "Only rules declaring this property, e.g. background-color." },
                "limit": { "type": "integer", "description": "Default 30." }
            }, "required": ["tab", "selector"] })
        },
    },
    Tool {
        name: "computed_style",
        method: "page/computed",
        description: "Computed values of CSS properties for the first element matching a selector (a useful default \
            set if `properties` is omitted). Use it to confirm an edit took effect: the browser silently drops \
            declarations it considers invalid.",
        schema: || {
            json!({ "type": "object", "properties": {
                "tab": tab_prop(),
                "selector": { "type": "string" },
                "properties": { "type": "array", "items": { "type": "string" } }
            }, "required": ["tab", "selector"] })
        },
    },
    Tool {
        name: "contrast_scan",
        method: "page/contrast",
        description: "Find visible text whose contrast with its background is below the WCAG threshold (minRatio, \
            default 4.5; 3 for large text), worst first. Backgrounds are composited from the element upwards; text \
            over background images is counted as unknown rather than checked, and text inside shadow roots isn't \
            reached. Disabled controls are skipped (WCAG exempts them). Problems like dark text left on a dark \
            background often don't stand out in a screenshot, so run this after changing colours.",
        schema: || {
            json!({ "type": "object", "properties": {
                "tab": tab_prop(),
                "minRatio": { "type": "number" },
                "limit": { "type": "integer", "description": "Maximum failures to list. Default 40." }
            }, "required": ["tab"] })
        },
    },
    Tool {
        name: "type_text",
        method: "page/type",
        description: "Fill in a text field as typing would: focus it, set its value, and fire input and change events, \
            so the page reacts (search suggestions, live filters). With submit, also press Enter and submit its form. \
            The events aren't trusted, so a rare page that checks for real keystrokes won't respond.",
        schema: || {
            json!({ "type": "object", "properties": {
                "tab": tab_prop(),
                "selector": { "type": "string" },
                "text": { "type": "string" },
                "submit": { "type": "boolean" }
            }, "required": ["tab", "selector", "text"] })
        },
    },
    Tool {
        name: "query",
        method: "page/query",
        description: "Find elements matching a CSS selector: how many, and the HTML of the first few (truncated). \
            Good for learning a page's structure and finding stable hooks (ids, data-* and aria-* attributes) \
            rather than generated class names.",
        schema: || {
            json!({ "type": "object", "properties": {
                "tab": tab_prop(),
                "selector": { "type": "string" },
                "limit": { "type": "integer", "description": "Default 10." },
                "maxLength": { "type": "integer", "description": "Characters of HTML per element. Default 500." }
            }, "required": ["tab", "selector"] })
        },
    },
    Tool {
        name: "eval",
        method: "page/eval",
        description: "Evaluate JavaScript in an agent tab and return the value of its last expression (must be \
            JSON-serialisable; a promise is awaited). It runs in an isolated world: it sees the page's DOM and \
            CSSOM, but not the page's own JavaScript globals, so it can't call the site's functions. Each call runs \
            in a fresh block scope, so const and let don't carry over between calls. Network requests are subject \
            to the page's Content-Security-Policy and may be refused. Useful for anything the other tools don't \
            cover, such as scrolling (window.scrollTo({top: 800, behavior: 'instant'})) or opening a menu by \
            clicking.",
        schema: || {
            json!({ "type": "object", "properties": {
                "tab": tab_prop(),
                "expression": { "type": "string" }
            }, "required": ["tab", "expression"] })
        },
    },
    Tool {
        name: "force_state",
        method: "page/force_state",
        description: "Show an element as if hovered, focused or pressed, so you can check and screenshot those \
            styles: agent tabs have no real pointer or keyboard focus, and scripted focus() doesn't trigger \
            :focus-visible. Like devtools' \"force element state\": rules using the states are cloned with an \
            attribute in place of the pseudo-class. States stay forced until you call this again (states: [] \
            clears them); only one element at a time. Rules in unreadable cross-origin stylesheets aren't cloned.",
        schema: || {
            json!({ "type": "object", "properties": {
                "tab": tab_prop(),
                "selector": { "type": "string" },
                "states": { "type": "array", "items": { "type": "string", "enum": ["hover", "active", "focus", "focus-visible", "focus-within"] },
                            "description": "States to force; [] clears." }
            }, "required": ["tab", "selector", "states"] })
        },
    },
    Tool {
        name: "styles_status",
        method: "styles/status",
        description: "The active theme, how many styles are loaded (in total and per service; other agents may \
            be adding styles for other services at the same time), and every diagnostic from loading them, with \
            file and line. It waits until file changes you just made have been loaded, so it's safe to call right \
            after saving. With `tab`, also which styles apply to that tab's page, whether the page has atelier's \
            style shim, and any prerequisite (site setting) the page shows isn't met. Check diagnostics after \
            editing: a style with errors keeps its last good version applied, so a mistake can look as if nothing \
            happened.",
        schema: || json!({ "type": "object", "properties": { "tab": tab_prop() } }),
    },
];

pub fn run(dir: Option<&str>) -> ExitCode {
    let mut server = Server {
        dir: paths::atelier_dir(dir),
        client: None,
    };
    let stdin = io::stdin();
    let mut stdout = io::stdout().lock();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let reply = match serde_json::from_str::<Value>(&line) {
            Ok(msg) => server.handle(msg),
            Err(e) => Some(error(Value::Null, -32700, format!("parse error: {e}"))),
        };
        if let Some(reply) = reply {
            let _ = writeln!(stdout, "{reply}");
            let _ = stdout.flush();
        }
    }
    ExitCode::SUCCESS
}

struct Server {
    dir: PathBuf,
    client: Option<Client>,
}

impl Server {
    fn handle(&mut self, msg: Value) -> Option<Value> {
        let id = msg.get("id").cloned()?; // notifications need no reply
        let params = msg.get("params").cloned().unwrap_or(Value::Null);
        Some(match msg.get("method").and_then(Value::as_str) {
            Some("initialize") => {
                let version = params
                    .get("protocolVersion")
                    .and_then(Value::as_str)
                    .unwrap_or(PROTOCOL_VERSION);
                ok(
                    id,
                    json!({
                        "protocolVersion": version,
                        "capabilities": { "tools": {} },
                        "serverInfo": { "name": "atelier", "version": env!("CARGO_PKG_VERSION") },
                        "instructions": INSTRUCTIONS,
                    }),
                )
            }
            Some("ping") => ok(id, json!({})),
            Some("tools/list") => ok(
                id,
                json!({ "tools": TOOLS.iter().map(|t| json!({
                    "name": t.name,
                    "description": t.description.split_whitespace().collect::<Vec<_>>().join(" "),
                    "inputSchema": (t.schema)(),
                })).collect::<Vec<_>>() }),
            ),
            Some("tools/call") => ok(id, self.call_tool(&params)),
            Some(m) => error(id, -32601, format!("unknown method `{m}`")),
            None => error(id, -32600, "missing `method`"),
        })
    }

    /// Runs a tool. Failures are tool results with isError, so the agent sees
    /// them and can act on them, rather than protocol errors.
    fn call_tool(&mut self, params: &Value) -> Value {
        let name = params
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let Some(tool) = TOOLS.iter().find(|t| t.name == name) else {
            return tool_error(format!("unknown tool `{name}`"));
        };
        let mut args = params.get("arguments").cloned().unwrap_or(json!({}));
        let save_as = match args.as_object_mut().and_then(|a| a.remove("saveAs")) {
            Some(Value::String(p)) => match self.save_path(&p) {
                Ok(path) => {
                    if p.ends_with(".jpg") || p.ends_with(".jpeg") {
                        args["format"] = json!("jpeg");
                    }
                    Some(path)
                }
                Err(e) => return tool_error(e),
            },
            Some(_) => return tool_error("`saveAs` must be a string"),
            None => None,
        };
        let return_image = args
            .as_object_mut()
            .and_then(|a| a.remove("returnImage"))
            .and_then(|v| v.as_bool())
            .unwrap_or(save_as.is_none());
        match self.browser_call(tool.method, args) {
            Ok(mut result) => {
                if let Some(path) = save_as {
                    let note = match save_image(&result, &path) {
                        Ok(()) => format!("Saved to {}.", path.display()),
                        Err(e) => format!("Couldn't save to {}: {e}", path.display()),
                    };
                    let notes = result["notes"].as_array().cloned().unwrap_or_default();
                    result["notes"] = json!([notes, vec![json!(note)]].concat());
                }
                if !return_image {
                    let notes: Vec<String> = result["notes"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter_map(Value::as_str)
                        .map(str::to_string)
                        .collect();
                    return json!({ "content": [{ "type": "text", "text": notes.join("\n") }] });
                }
                tool_result(tool.name, result)
            }
            Err(message) => tool_error(message),
        }
    }

    fn browser_call(&mut self, method_name: &str, args: Value) -> Result<Value, String> {
        // Connect lazily, and reconnect once if the daemon went away.
        for attempt in 0..2 {
            if self.client.is_none() {
                self.client = Some(self.connect()?);
            }
            let client = self.client.as_mut().expect("connected above");
            match client.call(
                method::BROWSER_CALL,
                json!({ "method": method_name, "params": args }),
            ) {
                Ok(v) => return Ok(v),
                Err(e) if e.kind() != io::ErrorKind::Other || attempt == 1 => {
                    self.client = None;
                    if attempt == 1 {
                        return Err(e.to_string());
                    }
                }
                // A JSON-RPC error from the daemon or browser: the message is meant for the agent.
                Err(e) => return Err(e.to_string()),
            }
        }
        unreachable!()
    }

    /// Where `saveAs` writes: inside the owned directory, as an image.
    fn save_path(&self, rel: &str) -> Result<PathBuf, String> {
        let rel_path = std::path::Path::new(rel);
        let ok_ext = [".png", ".jpg", ".jpeg"].iter().any(|e| rel.ends_with(e));
        if rel_path.is_absolute()
            || rel_path
                .components()
                .any(|c| matches!(c, std::path::Component::ParentDir))
            || !ok_ext
        {
            return Err(format!(
                "`saveAs` must be a relative path inside the owned directory, ending in .png, .jpg or .jpeg (got `{rel}`)"
            ));
        }
        Ok(self.dir.join(rel_path))
    }

    fn connect(&self) -> Result<Client, String> {
        let dir = self.dir.canonicalize().map_err(|e| {
            format!("atelier's owned directory {} isn't usable ({e}); the user may need to run `atelier setup`", self.dir.display())
        })?;
        match Client::connect(&dir, Role::Mcp) {
            Ok(Some((client, _))) => Ok(client),
            Ok(None) => Err(
                "atelier's daemon isn't running. It starts when Firefox with the atelier extension connects, so Firefox \
                 is probably closed or the extension isn't loaded. Ask the user to open it."
                    .into(),
            ),
            Err(e) => Err(format!("couldn't reach atelier's daemon: {e}")),
        }
    }
}

fn tool_result(tool: &str, mut result: Value) -> Value {
    if tool == "screenshot" {
        let data = result
            .get("data")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let mime = result
            .get("mimeType")
            .and_then(Value::as_str)
            .unwrap_or("image/png")
            .to_string();
        let mut content = vec![json!({ "type": "image", "data": data, "mimeType": mime })];
        if let Some(notes) = result
            .get("notes")
            .and_then(Value::as_array)
            .filter(|n| !n.is_empty())
        {
            let text = notes
                .iter()
                .filter_map(Value::as_str)
                .collect::<Vec<_>>()
                .join("\n");
            content.push(json!({ "type": "text", "text": text }));
        }
        return json!({ "content": content });
    }
    if let Some(obj) = result.as_object_mut() {
        obj.remove("data");
    }
    json!({ "content": [{ "type": "text", "text": serde_json::to_string_pretty(&result).unwrap_or_default() }] })
}

fn save_image(result: &Value, path: &std::path::Path) -> io::Result<()> {
    use base64::Engine;
    let data = result["data"].as_str().unwrap_or_default();
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data)
        .map_err(io::Error::other)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(path, bytes)
}

fn tool_error(message: impl Into<String>) -> Value {
    json!({ "content": [{ "type": "text", "text": message.into() }], "isError": true })
}

fn ok(id: Value, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

fn error(id: Value, code: i64, message: impl Into<String>) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message.into() } })
}
