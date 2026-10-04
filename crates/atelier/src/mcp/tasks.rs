//! Task tools for `atelier mcp` (SPEC §8, §10.1), and the `work` prompt that
//! starts a session on the queue.
//!
//! Each `atelier mcp` process is one session. It claims tasks under its own
//! session id, renews their leases as it's used, binds the tabs it opens to
//! the task it's working on (SPEC §6.2), and saves screenshots into that
//! task's tree. As with the browser tools, everything here is read by agents:
//! see PROMPTING.md and AGENT-EXPERIENCE.md before changing the wording.

use super::{Server, Tool, tool_error};
use atelier_proto::{SubmitResult, Task, TaskKind, TaskState, task_method as tm};
use serde_json::{Value, json};
use std::fmt::Write as _;
use std::path::PathBuf;
use std::time::{Duration, Instant};

/// Renew held leases at most this often (they last 10 minutes).
const HEARTBEAT_EVERY: Duration = Duration::from_secs(60);
/// The longest `task_claim` waits for work.
const MAX_WAIT_SECS: u64 = 300;

fn task_prop() -> Value {
    json!({ "type": "string", "description": "The task's id. Optional while you hold just one task." })
}

pub(super) const TASK_TOOLS: &[Tool] = &[
    Tool {
        name: "task_list",
        method: "",
        description: "The queue: tasks waiting for someone to work on them, and any this session holds. Each task \
            is one piece of work on one service (a site), asked for by the user.",
        schema: || json!({ "type": "object", "properties": {} }),
    },
    Tool {
        name: "task_create",
        method: "",
        description: "Add a task to the queue, for when the user asks for something in conversation rather than \
            from the browser. Put their request in their own words in `description`; add your own understanding \
            in `note` if it helps whoever does the work (which may be you, via task_claim). kind: create (style a \
            site that has no style yet), revise (change an existing style), repair (fix a broken one). Give \
            `service` (the directory name under services/) when it's known; for a new site it's chosen when the \
            work lands.",
        schema: || {
            json!({ "type": "object", "properties": {
                "description": { "type": "string", "description": "What the user asked for, in their words." },
                "kind": { "type": "string", "enum": ["create", "revise", "repair"], "description": "Default create." },
                "service": { "type": "string" },
                "origin": { "type": "string", "description": "A URL on the site concerned." },
                "note": { "type": "string" }
            }, "required": ["description"] })
        },
    },
    Tool {
        name: "task_claim",
        method: "",
        description: "Take a task to work on: the one with `id`, or else the oldest queued. You get a working copy \
            of the owned directory (the task's tree) to edit, and the brief. Tabs you open from then on show the \
            tree's styles; the user's own tabs keep showing the owned directory until you submit. With waitSeconds \
            (up to 300), waits that long for a task if none is queued, which is how to keep working through a \
            queue as new requests arrive. A claim is a lease of about 10 minutes, renewed whenever you use any \
            atelier tool; if it runs out, the task goes back to the queue with its tree intact, and someone else \
            may pick it up.",
        schema: || {
            json!({ "type": "object", "properties": {
                "id": { "type": "string" },
                "waitSeconds": { "type": "integer", "description": "If nothing is queued, wait up to this long for a task. Default 0." }
            } })
        },
    },
    Tool {
        name: "task_info",
        method: "",
        description: "The brief for a task you hold, where its tree is, and which files in the tree you've \
            changed so far.",
        schema: || json!({ "type": "object", "properties": { "task": task_prop() } }),
    },
    Tool {
        name: "task_submit",
        method: "",
        description: "Land your work: the files you changed in the task's tree are checked and copied into the \
            owned directory, where the user's tabs pick them up at once. The landing is recorded in the journal, \
            so the user can undo it, and may be committed by the user's own hook. `summary` becomes that history: \
            what changed and why, the way you'd write a commit message for a colleague. `assumptions` lists calls \
            you made that the user might have made differently, so they can see them at a glance. \
            A submission can come back with problems instead: a file outside the task's service, a style that \
            doesn't load, or a file the user (or another task) changed while you worked. Those are information, \
            not failure: each says what to do, and you fix the tree and submit again.",
        schema: || {
            json!({ "type": "object", "properties": {
                "task": task_prop(),
                "summary": { "type": "string" },
                "assumptions": { "type": "array", "items": { "type": "string" } }
            }, "required": ["summary"] })
        },
    },
    Tool {
        name: "task_decline",
        method: "",
        description: "Decline a task, with your reason, when it can't or shouldn't be done as asked: for example, \
            the site draws its content on a canvas that CSS can't restyle, or the request conflicts with the \
            theme. That's a legitimate outcome. The reason goes to the user, who decides what happens next; the \
            task isn't handed to someone else. Nothing in the tree lands.",
        schema: || {
            json!({ "type": "object", "properties": {
                "task": task_prop(),
                "reason": { "type": "string" }
            }, "required": ["reason"] })
        },
    },
    Tool {
        name: "task_release",
        method: "",
        description: "Stop working on a task for now without finishing it: it goes back to the queue with its \
            tree as you left it, and your `handoff` note is shown to whoever claims it next (perhaps you, in \
            another session). Say what's done, what's left, and anything you'd want to know if you were picking \
            it up cold.",
        schema: || {
            json!({ "type": "object", "properties": {
                "task": task_prop(),
                "handoff": { "type": "string" }
            }, "required": ["handoff"] })
        },
    },
];

/// The `work` prompt (SPEC §9.2): how a session started on the queue
/// proceeds. Harnesses show it as a command, e.g. `/mcp__atelier__work` in
/// Claude Code.
pub(super) const WORK_PROMPT: &str = "\
I'd like your help with atelier's queue. atelier keeps userstyles that make the websites I use match my \
desktop theme, and agents write them. Requests I make from the browser (or in this conversation) become \
tasks; each is one piece of work on one site.

How a session goes:

1. Look at the queue with task_list.{REQUEST}
2. Claim a task with task_claim. It gives you the brief, and a working copy of my styles (the task's tree) \
to edit with your file tools. Tabs you open with tab_open show the tree's styles, so you can see your work \
in my real browser, logged in where I am, without it reaching my own tabs.
3. Read the theme (themes/<theme>/THEME.md in the tree) before anything else: it's what I want things to look \
like, in my words. Then the service's notes.md and existing styles, if it has them.
4. Do the work, checking it in the browser as you go. When it's done, submit it with task_submit and a \
summary. It lands in my styles at once, and I can undo it.
5. Then the next task, until the queue is empty. Tell me briefly what landed, what you assumed, and \
anything you'd like me to decide.

I started this session, so I may well be here. If something is really mine to decide, ask me. If I don't \
answer, or it's a small call, make a reasonable choice and list it in `assumptions` when you submit. If a task \
can't or shouldn't be done as asked, decline it and say why; that's a legitimate answer, and nobody else will \
be asked to do it instead. If you need to stop partway, task_release keeps your work for whoever continues, \
with your note.

If atelier's tools get in your way, are missing something, or say something confusing, please tell me \
specifically. I'm developing atelier, and that's some of the most useful feedback I get.";

impl Server {
    /// Handles a task tool. None if `name` isn't one.
    pub(super) fn task_tool(&mut self, name: &str, args: &Value) -> Option<Value> {
        let result = match name {
            "task_list" => self.task_list(),
            "task_create" => self.task_create(args),
            "task_claim" => self.task_claim(args),
            "task_info" => self.task_arg(args).and_then(|id| self.task_info(&id)),
            "task_submit" => self.task_submit(args),
            "task_decline" => self.task_finish(args, tm::DECLINE, "reason"),
            "task_release" => self.task_finish(args, tm::RELEASE, "handoff"),
            _ => return None,
        };
        Some(match result {
            Ok(text) => json!({ "content": [{ "type": "text", "text": text }] }),
            Err(e) => tool_error(e),
        })
    }

    /// Renews the leases this session holds, at most once a minute. Any
    /// tool call does it, so an agent at work never has to think about it.
    pub(super) fn heartbeat(&mut self) {
        if self.held.is_empty()
            || self
                .last_heartbeat
                .is_some_and(|t| t.elapsed() < HEARTBEAT_EVERY)
        {
            return;
        }
        self.last_heartbeat = Some(Instant::now());
        let session = self.session.clone();
        for id in self.held.keys().cloned().collect::<Vec<_>>() {
            if let Err(e) = self.daemon_call(tm::HEARTBEAT, json!({ "id": id, "session": session }))
            {
                // Only let go if the task really isn't ours any more, not
                // because the daemon was briefly out of reach.
                let lost = match self.daemon_call(tm::GET, json!({ "id": id })) {
                    Ok(t) => parse::<Task>(t).is_ok_and(|t| {
                        t.state != TaskState::Queued
                            && t.lease.as_ref().is_none_or(|l| l.session != session)
                    }),
                    Err(_) => false,
                };
                if !lost {
                    continue;
                }
                self.held.remove(&id);
                self.notices.push(format!(
                    "You no longer hold task {id}: {e}. Its lease ran out while you weren't using atelier's \
                     tools, and it may now be someone else's. Check with task_list before carrying on with it."
                ));
            }
        }
    }

    /// The task a call is about: `task` if given, else the one task held.
    pub(super) fn task_arg(&self, args: &Value) -> Result<String, String> {
        if let Some(id) = args.get("task").and_then(Value::as_str) {
            return Ok(id.to_string());
        }
        match self.held.len() {
            1 => Ok(self.held.keys().next().unwrap().clone()),
            0 => Err("you don't hold a task in this session; claim one with task_claim".into()),
            _ => Err(format!(
                "you hold several tasks ({}); say which with `task`",
                self.held.keys().cloned().collect::<Vec<_>>().join(", ")
            )),
        }
    }

    /// The tree of a task this session holds.
    pub(super) fn tree_of(&self, task: &str) -> Option<PathBuf> {
        self.held.get(task).cloned()
    }

    fn task_list(&mut self) -> Result<String, String> {
        let tasks: Vec<Task> = parse(self.daemon_call(tm::LIST, json!({}))?)?;
        let mine: Vec<&Task> = tasks
            .iter()
            .filter(|t| self.held.contains_key(&t.id))
            .collect();
        let queued: Vec<&Task> = tasks
            .iter()
            .filter(|t| t.state == TaskState::Queued)
            .collect();
        let mut out = String::new();
        if !mine.is_empty() {
            out.push_str("You hold:\n");
            for t in &mine {
                let _ = writeln!(out, "- {}", one_line(t));
            }
            out.push('\n');
        }
        if queued.is_empty() {
            out.push_str("Nothing is queued.");
        } else {
            out.push_str("Queued, oldest first:\n");
            for t in &queued {
                let resumed = if t.tree.is_some() {
                    " (started before; its tree is kept)"
                } else {
                    ""
                };
                let _ = writeln!(out, "- {}{resumed}", one_line(t));
            }
        }
        let others = tasks
            .iter()
            .filter(|t| t.state == TaskState::Claimed && !self.held.contains_key(&t.id))
            .count();
        if others > 0 {
            let _ = write!(out, "\n{others} more being worked on by other sessions.");
        }
        Ok(out.trim_end().to_string())
    }

    fn task_create(&mut self, args: &Value) -> Result<String, String> {
        let description = args
            .get("description")
            .and_then(Value::as_str)
            .ok_or("`description` is required: what the user asked for")?;
        let task: Task = parse(self.daemon_call(
            tm::CREATE,
            json!({
                "kind": args.get("kind").and_then(Value::as_str).unwrap_or("create"),
                "service": args.get("service"),
                "brief": {
                    "description": description,
                    "origin": args.get("origin"),
                    "note": args.get("note"),
                },
            }),
        )?)?;
        Ok(format!(
            "Queued as task {}. Claim it with task_claim to work on it.",
            task.id
        ))
    }

    fn task_claim(&mut self, args: &Value) -> Result<String, String> {
        let id = args.get("id").and_then(Value::as_str);
        let wait = args
            .get("waitSeconds")
            .and_then(Value::as_u64)
            .unwrap_or(0)
            .min(MAX_WAIT_SECS);
        let deadline = Instant::now() + Duration::from_secs(wait);
        let task: Task = loop {
            let claimed =
                self.daemon_call(tm::CLAIM, json!({ "id": id, "session": self.session }))?;
            if !claimed.is_null() {
                break parse(claimed)?;
            }
            if Instant::now() >= deadline {
                return Ok(if wait > 0 {
                    format!("Nothing was queued in the {wait}s waited.")
                } else {
                    "Nothing is queued.".into()
                });
            }
            std::thread::sleep(Duration::from_secs(2));
        };
        let tree = PathBuf::from(task.tree.clone().unwrap_or_default());
        self.held.insert(task.id.clone(), tree);
        self.last_heartbeat = Some(Instant::now());
        self.task_info(&task.id)
    }

    fn task_info(&mut self, id: &str) -> Result<String, String> {
        let task: Task = parse(self.daemon_call(tm::GET, json!({ "id": id }))?)?;
        if !self.held.contains_key(id) {
            return Err(format!(
                "task {id} isn't held by this session ({}); claim it with task_claim",
                state_name(task.state)
            ));
        }
        let changes: Vec<atelier_proto::FileChange> =
            parse(self.daemon_call(tm::CHANGES, json!({ "id": id }))?)?;
        Ok(brief(&task, &changes))
    }

    fn task_submit(&mut self, args: &Value) -> Result<String, String> {
        let id = self.task_arg(args)?;
        let summary = args
            .get("summary")
            .and_then(Value::as_str)
            .ok_or("`summary` is required: what changed and why")?;
        let result: SubmitResult = parse(self.daemon_call(
            tm::SUBMIT,
            json!({
                "id": id,
                "session": self.session,
                "summary": summary,
                "assumptions": args.get("assumptions").cloned().unwrap_or(json!([])),
            }),
        )?)?;
        match result {
            SubmitResult::Landed { journal, changed } => {
                self.held.remove(&id);
                let mut out = format!(
                    "Landed as journal entry {journal}. The user's tabs have it now, and so do this task's tabs, \
                     which show the owned directory again. Changed:\n"
                );
                for c in &changed {
                    let _ = writeln!(out, "- {} ({})", c.path, change_name(c.change));
                }
                out.push_str("\nClose this task's tabs if you're done with them.");
                Ok(out)
            }
            SubmitResult::Rejected { problems } => {
                let mut out = String::from(
                    "Not landed yet. Nothing was written to the owned directory; the task is still yours.\n",
                );
                for p in &problems {
                    let at = p
                        .path
                        .as_deref()
                        .map(|p| format!(" {p}:"))
                        .unwrap_or_default();
                    let _ = write!(out, "\n- [{}]{at} {}", p.kind, p.message);
                    if let Some(current) = &p.current {
                        let _ = write!(out, "\n  Current contents:\n```\n{current}```");
                    }
                }
                Ok(out)
            }
        }
    }

    /// Decline or release: either way, this session lets go of the task.
    fn task_finish(&mut self, args: &Value, method: &str, field: &str) -> Result<String, String> {
        let id = self.task_arg(args)?;
        let text = args
            .get(field)
            .and_then(Value::as_str)
            .ok_or_else(|| format!("`{field}` is required"))?;
        self.daemon_call(
            method,
            json!({ "id": id, "session": self.session, field: text }),
        )?;
        self.held.remove(&id);
        Ok(if method == tm::DECLINE {
            format!("Declined task {id}. The user will see your reason.")
        } else {
            format!("Released task {id} back to the queue, with its tree and your note.")
        })
    }
}

fn parse<T: serde::de::DeserializeOwned>(v: Value) -> Result<T, String> {
    serde_json::from_value(v).map_err(|e| format!("unexpected reply from atelier's daemon: {e}"))
}

fn kind_name(k: TaskKind) -> &'static str {
    match k {
        TaskKind::Create => "create",
        TaskKind::Revise => "revise",
        TaskKind::Repair => "repair",
        TaskKind::Port => "port",
        TaskKind::Audit => "audit",
        TaskKind::Notes => "notes",
    }
}

fn state_name(s: TaskState) -> &'static str {
    match s {
        TaskState::Queued => "queued",
        TaskState::Claimed => "claimed",
        TaskState::Landed => "landed",
        TaskState::Declined => "declined",
        TaskState::Abandoned => "abandoned",
    }
}

fn change_name(c: atelier_proto::ChangeKind) -> &'static str {
    match c {
        atelier_proto::ChangeKind::Added => "added",
        atelier_proto::ChangeKind::Modified => "modified",
        atelier_proto::ChangeKind::Deleted => "deleted",
    }
}

fn one_line(t: &Task) -> String {
    let service = t.service.as_deref().unwrap_or("new site");
    format!(
        "{} [{}, {service}] {}",
        t.id,
        kind_name(t.kind),
        t.brief.description.lines().next().unwrap_or_default()
    )
}

/// What an agent needs to start (or resume) a task.
fn brief(t: &Task, changes: &[atelier_proto::FileChange]) -> String {
    let theme = t.theme.as_deref().unwrap_or("<theme>");
    let tree = t.tree.as_deref().unwrap_or("?");
    let exists = |rel: &str| std::path::Path::new(tree).join(rel).exists();
    let mut out = format!("# Task {}: {}\n\n", t.id, kind_name(t.kind));
    let _ = writeln!(out, "The user asked: {}", t.brief.description);
    if let Some(origin) = &t.brief.origin {
        let _ = writeln!(out, "From the page: {origin}");
    }
    if let Some(note) = &t.brief.note {
        let _ = writeln!(out, "Note: {note}");
    }
    match &t.service {
        Some(s) => {
            let _ = writeln!(out, "Service: {s} (services/{s}/)");
        }
        None => {
            let _ = writeln!(
                out,
                "Service: not chosen yet. Name it after the site (lowercase, e.g. `lobsters` for lobste.rs) and \
                 put everything under services/<name>/."
            );
        }
    }
    let _ = writeln!(out, "Theme: {theme}");

    let _ = write!(
        out,
        "\n## Where to work\n\nThe task's tree is {tree}: a copy of the owned directory for this task alone. \
         Edit files there with your file tools. Tabs you open with tab_open show the tree's styles and pick \
         up each save within a second; the user's own tabs don't see any of it until you submit. \
         screenshot's saveAs writes into the tree too.\n\nWorth reading first, in the tree:\n"
    );
    let theme_md = format!("themes/{theme}/THEME.md");
    if exists(&theme_md) {
        let _ = writeln!(
            out,
            "- {theme_md}: what the user wants things to look like, in their words."
        );
    } else {
        let _ = writeln!(
            out,
            "- There's no {theme_md}, so the theme isn't written down. Ask the user what they want, or work \
             from the existing styles and say what you inferred."
        );
    }
    match &t.service {
        Some(s) => {
            let present: Vec<String> = [
                format!("services/{s}/notes.md"),
                format!("services/{s}/service.toml"),
                format!("services/{s}/{theme}/"),
            ]
            .into_iter()
            .filter(|p| exists(p))
            .collect();
            if present.is_empty() {
                let _ = writeln!(
                    out,
                    "- services/{s}/ has no files yet; one or two other services are the best guide to the \
                     format."
                );
            } else {
                let _ = writeln!(
                    out,
                    "- {} (the only files there so far).",
                    present.join(", ")
                );
            }
        }
        None => {
            let _ = writeln!(
                out,
                "- One or two existing services under services/, for the format and the level of care the user \
                 is used to."
            );
        }
    }
    let _ = writeln!(
        out,
        "\nA task changes one service: everything you change must be under services/<service>/. If you \
         think the theme itself is wrong or unclear, say so (to the user, or in your summary) rather than \
         editing it."
    );

    if let Some(h) = &t.handoff {
        let _ = write!(
            out,
            "\n## Handoff from whoever worked on this before\n\n{h}\n"
        );
    }
    if !changes.is_empty() {
        out.push_str("\n## Changed in the tree so far\n\n");
        for c in changes {
            let _ = writeln!(out, "- {} ({})", c.path, change_name(c.change));
        }
    }
    let _ = write!(
        out,
        "\n## The format\n\n\
         - services/<service>/{theme}/*.user.css: UserCSS, i.e. a /* ==UserStyle== */ metadata comment \
         (@name, @namespace, @version, @description), then CSS in @-moz-document sections whose matchers are \
         url(), url-prefix(), domain() and regexp() (a JavaScript regular expression for the whole URL). Every \
         file in the folder is loaded, in name order. It's plain CSS as Firefox reads it, so nesting works; there's \
         no preprocessor. Remote url()s are refused, except Google Fonts, since a stylesheet can leak what's on \
         the page through the URLs it loads.\n\
         - services/<service>/service.toml: `description` (the site, in a few words), `summary` (what the \
         styles cover, for the user), and `[[prerequisites]]` for site settings a style depends on: \
         `description` (what the user should set, in their terms) and `check` (a CSS selector that matches \
         something on the page only when the setting is on). The check runs on each page the style applies to, \
         once it has loaded; if it matches nothing, the toolbar button shows a badge and the description.\n\
         - services/<service>/notes.md: decisions and their reasons, for whoever works on this service next, \
         independent of theme.\n\
         - services/<service>/{theme}/previews/*.jpg: 2–3 screenshots of representative pages, at viewport \
         size and scale 1 (screenshot with saveAs and a .jpg name), named for what they show \
         (repo-home.jpg). They let the user judge the style without visiting the site.\n\
         \n## Finishing\n\n\
         Record lasting decisions in notes.md, leave previews, then task_submit with a summary, and any \
         assumptions.\n\n\
         Your claim lasts about 10 minutes and renews whenever you use an atelier tool; task_info renews it \
         too, if you'll be away from them for a while. If it does run out and someone else claims the task, \
         they carry on in this same tree, so further edits would mix with their work. Your next atelier tool \
         call tells you if that has happened."
    );
    out
}
