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
/// The longest task_ask holds a task while the user answers (a lease's length).
const MAX_HOLD_SECS: u64 = 600;

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
            you made that the user might have made differently and that you haven't already posted with \
            task_ask (those go with the landing as they are; don't repeat them). \
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
        name: "task_ask",
        method: "",
        description: "Put calls to the user: decisions you faced, as questions or as choices you made. They reach \
            the user in the browser with your screenshots, whether or not they're watching this conversation, \
            and they answer a batch at once, so gather calls and send them together at a natural checkpoint \
            (a first pass is a good one). Say what you'd choose (`choice`; one of the options, if any): \
            answering can then be one click. `scope: theme` marks a call about the whole theme. \
            Each call's `wait` (default: the batch's): record (you go ahead; a different answer later becomes \
            a new task; right for most calls, including \"I'd keep this, confirm?\"; record calls go with the \
            landing, so don't repeat them as assumptions), review (it shouldn't land until answered: the \
            options mean substantially different work, or you're not confident in any), or block (one \
            question you can't make a reasonable call on, that can't wait). If any call is review or block, \
            the task parks: you stop holding it, its tree is kept, and it returns to the queue with the \
            answers and your `handoff`. Screenshots: paths in the tree or scratch space (screenshot with \
            attach: true). For this-or-that questions, `variant` lets the user flip between options live; \
            the brief explains how.",
        schema: || {
            json!({ "type": "object", "properties": {
                "task": task_prop(),
                "wait": { "type": "string", "enum": ["record", "review", "block"], "description": "For calls that don't give their own. Default record." },
                "summary": { "type": "string", "description": "A line to go with the batch, e.g. what state the work is in." },
                "waitForAnswers": { "type": "integer", "description": "With review or block, when the user may be around to answer soon: keep the task, and wait this many seconds (up to 600) for the answers, which then come back to you here. If they don't come in time, the task waits for them as usual. Not useful in a session nobody is watching." },
                "handoff": { "type": "string", "description": "With review or block: a note for whoever picks the task up after the answers (perhaps you): what's done, what's left." },
                "calls": { "type": "array", "items": { "type": "object", "properties": {
                    "question": { "type": "string" },
                    "context": { "type": "string", "description": "What it's about and why it matters, for someone looking at your screenshot rather than the page." },
                    "options": { "type": "array", "items": { "type": "string" } },
                    "choice": { "type": "string", "description": "What you'd do (or did), if you had to decide: exactly one of the options, when there are options (reasons go in context)." },
                    "scope": { "type": "string", "enum": ["site", "theme"], "description": "Default site." },
                    "wait": { "type": "string", "enum": ["record", "review", "block"] },
                    "variant": { "type": "string", "description": "For choosing between versions of part of a style: the name the style file marks it with (see the tool description). Options and choice then come from the variant files." },
                    "screenshots": { "type": "array", "items": { "type": "string" } }
                }, "required": ["question"] } }
            }, "required": ["calls"] })
        },
    },
    Tool {
        name: "theme_propose",
        method: "",
        description: "Propose a change to THEME.md, the user's own description of the look they want. You never \
            edit THEME.md yourself; the user sees your proposal as a diff in the browser and accepts it (perhaps \
            after editing it), or declines it with a note. Propose when something settles a question for the theme \
            as a whole: a gap or contradiction you found, or an interpretation you settled on, so the next agent \
            doesn't have to work it out again. It needn't wait for an answer: propose your interpretation as soon \
            as you've settled on one, and the user confirms or corrects it. THEME.md says what the user wants, not \
            what's possible today: where a limit of atelier or the browser stopped you, say so in notes.md and your \
            summary rather than writing the limit into the theme, so it doesn't outlive the fix. Write it in \
            THEME.md's own voice and place (it's the user's \
            document, and reads as theirs), keep it short, and say in `why` what it comes from. Edits apply to \
            THEME.md as it is now: each `find` must match its current text exactly, once (if it doesn't, the \
            error includes the current text); an edit without `find` appends.",
        schema: || {
            json!({ "type": "object", "properties": {
                "summary": { "type": "string", "description": "What changes, in a line." },
                "why": { "type": "string", "description": "What it comes from: the user's answer, the sites where it came up." },
                "edits": { "type": "array", "items": { "type": "object", "properties": {
                    "find": { "type": "string", "description": "Text in THEME.md to replace (exactly, once). Omit to append." },
                    "replace": { "type": "string" }
                }, "required": ["replace"] } },
                "task": task_prop()
            }, "required": ["summary", "edits"] })
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
const WORK_PROMPT: &str = "\
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

{PRESENCE} If a task can't or shouldn't be done as asked, decline it and say why; that's a legitimate answer, \
and nobody else will be asked to do it instead. If you need to stop partway, task_release keeps your work for \
whoever continues, with your note.

If atelier's tools get in your way, are missing something, or say something confusing, please tell me \
specifically. I'm developing atelier, and that's some of the most useful feedback I get.";

/// What the work prompt says about whether the user is there to ask. A
/// session the daemon started headless (ATELIER_SESSION, SPEC §9.1) has
/// nobody watching it.
fn presence() -> &'static str {
    match std::env::var("ATELIER_SESSION").as_deref() {
        Ok("headless") => {
            "atelier started this session by itself, and nobody is watching this conversation: your final \
             message only goes to a log. Questions reach me through task_ask, in the browser, whenever I next \
             look; each task's brief says how readily to ask. What else I'll read is each landing's summary \
             and `assumptions`."
        }
        _ => {
            "I started this session (or asked for it), so I may be here, but don't count on it. Put questions \
             about the work to me with task_ask: they reach me in the browser with your screenshots, whether \
             or not I'm watching this conversation, and they stay with the task. When you need an answer \
             before going on, task_ask can wait a few minutes for me (waitForAnswers) before parking the task. Each task's brief says how \
             readily to ask. Quick things about the session itself you can just ask here."
        }
    }
}

/// The work prompt, with the user's request (if any) worked in.
pub(super) fn work_prompt(request: Option<&str>) -> String {
    let request = match request {
        Some(r) => format!(
            " I've also just asked for this: \"{r}\". If it isn't in the queue already, add it with task_create, in my words."
        ),
        None => String::new(),
    };
    WORK_PROMPT
        .replace("{REQUEST}", &request)
        .replace("{PRESENCE}", presence())
}

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
            "task_ask" => self.task_ask(args),
            "theme_propose" => self.theme_propose(args),
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
        let waiting: Vec<&Task> = tasks
            .iter()
            .filter(|t| t.state == TaskState::Waiting)
            .collect();
        if !waiting.is_empty() {
            out.push_str(
                "\nWaiting for the user's answers (they come back to the queue when answered):\n",
            );
            for t in &waiting {
                let _ = writeln!(out, "- {}", one_line(t));
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
        let batches: Vec<atelier_proto::Batch> = parse(self.daemon_call(
            atelier_proto::call_method::LIST,
            json!({ "open": false, "task": id }),
        )?)?;
        let stats: atelier_proto::CallStats = parse(self.daemon_call(
            atelier_proto::call_method::STATS,
            json!({ "theme": task.theme }),
        )?)?;
        let proposals: Vec<atelier_proto::Proposal> = parse(self.daemon_call(
            atelier_proto::theme_method::PROPOSALS,
            json!({ "open": false }),
        )?)?;
        let proposals: Vec<_> = proposals
            .into_iter()
            .filter(|p| Some(&p.theme) == task.theme.as_ref())
            .filter(|p| {
                matches!(
                    p.state,
                    atelier_proto::ProposalState::Open | atelier_proto::ProposalState::Declined
                )
            })
            .take(8)
            .collect();
        Ok(brief(&task, &changes, &batches, &stats, &proposals))
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

    fn task_ask(&mut self, args: &Value) -> Result<String, String> {
        use atelier_proto::{Batch, Wait};
        let id = self.task_arg(args)?;
        let tree = self
            .tree_of(&id)
            .ok_or_else(|| format!("you don't hold task {id}"))?;
        let wait = args.get("wait").and_then(Value::as_str).unwrap_or("record");
        let hold = args
            .get("waitForAnswers")
            .and_then(Value::as_u64)
            .filter(|s| *s > 0)
            .map(|s| s.min(MAX_HOLD_SECS));
        let calls: Vec<Value> = args
            .get("calls")
            .and_then(Value::as_array)
            .cloned()
            .ok_or("`calls` is required: a list of { question, context?, options?, choice?, scope?, screenshots? }")?;
        let calls: Vec<Value> = calls
            .into_iter()
            .map(|mut c| {
                // Screenshots become attachments, with relative paths taken
                // as relative to the tree.
                let shots: Vec<String> = c
                    .get("screenshots")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .filter_map(Value::as_str)
                    .map(|p| {
                        let p = std::path::Path::new(p);
                        if p.is_absolute() {
                            p.to_path_buf()
                        } else {
                            tree.join(p)
                        }
                        .display()
                        .to_string()
                    })
                    .collect();
                if let Some(o) = c.as_object_mut() {
                    o.remove("screenshots");
                    o.insert("attachments".into(), json!(shots));
                    if let Some(Value::String(name)) = o.remove("variant") {
                        o.insert("variant".into(), json!({ "name": name }));
                    }
                }
                c
            })
            .collect();
        let batch: Batch = parse(self.daemon_call(
            atelier_proto::call_method::POST,
            json!({ "task": id, "session": self.session, "wait": wait, "summary": args.get("summary"), "calls": calls, "holdMs": hold.map(|s| (s + 30) * 1000) }),
        )?)?;
        if batch.wait != Wait::Record
            && let Some(secs) = hold
        {
            return self.await_answers(
                &id,
                &batch.id,
                secs,
                args.get("handoff").and_then(Value::as_str),
            );
        }
        if batch.wait != Wait::Record
            && let Some(h) = args.get("handoff").and_then(Value::as_str)
        {
            // The task is parked: set its note for whoever resumes it.
            self.daemon_call(tm::NOTE, json!({ "id": id, "handoff": h }))?;
        }
        let n = batch.calls.len();
        Ok(match batch.wait {
            Wait::Record => format!(
                "Posted {n} call(s) for the record ({}). Carry on and land when you're ready; if the user changes \
                 one, that becomes a new task. task_info shows answers that come in while you're still working.",
                batch.id
            ),
            Wait::Review | Wait::Block => {
                self.held.remove(&id);
                format!(
                    "Posted {n} call(s) ({}). Task {id} now waits for the user's answers: nothing has landed, you \
                     don't hold it any more, and its tree is kept. It comes back to the queue with the answers, \
                     for whoever claims it next (perhaps you), and the calls you posted for the record go with \
                     it. Its tabs keep showing the tree. Meanwhile, task_list for other work.",
                    batch.id
                )
            }
        })
    }

    /// Holds a task while the user answers a batch, for up to `secs`. If
    /// they do, the answers come back here and the session carries on;
    /// if not, the task parks as it would have at once.
    fn await_answers(
        &mut self,
        task: &str,
        batch: &str,
        secs: u64,
        handoff: Option<&str>,
    ) -> Result<String, String> {
        let deadline = Instant::now() + Duration::from_secs(secs);
        loop {
            let batches: Vec<atelier_proto::Batch> = parse(self.daemon_call(
                atelier_proto::call_method::LIST,
                json!({ "open": false, "task": task }),
            )?)?;
            if let Some(b) = batches
                .iter()
                .find(|b| b.id == batch && b.answered.is_some())
            {
                // Answered: renew the lease (the hold set it short), and go on.
                self.daemon_call(
                    tm::HEARTBEAT,
                    json!({ "id": task, "session": self.session }),
                )?;
                self.last_heartbeat = Some(Instant::now());
                return Ok(format!(
                    "The user answered. You still hold task {task}; carry on with their answers.\n{}",
                    batch_text(b)
                ));
            }
            if Instant::now() >= deadline {
                break;
            }
            std::thread::sleep(Duration::from_secs(2));
        }
        self.daemon_call(
            atelier_proto::call_method::PARK,
            json!({ "task": task, "session": self.session }),
        )?;
        if let Some(h) = handoff {
            self.daemon_call(tm::NOTE, json!({ "id": task, "handoff": h }))?;
        }
        self.held.remove(task);
        Ok(format!(
            "No answer within {secs}s, so task {task} now waits for the user: nothing has landed, you don't hold \
             it any more, and its tree is kept. It comes back to the queue with the answers, for whoever claims it \
             next (perhaps you). Meanwhile, task_list for other work."
        ))
    }

    fn theme_propose(&mut self, args: &Value) -> Result<String, String> {
        let task = args
            .get("task")
            .and_then(Value::as_str)
            .map(str::to_string)
            .or_else(|| (self.held.len() == 1).then(|| self.held.keys().next().unwrap().clone()));
        let p: atelier_proto::Proposal = parse(self.daemon_call(
            atelier_proto::theme_method::PROPOSE,
            json!({ "edits": args.get("edits"), "summary": args.get("summary"), "why": args.get("why"), "task": task }),
        )?)?;
        Ok(format!(
            "Proposed ({}). The user will see it as a diff in the inbox and accept, edit or decline it; \
             until then THEME.md is unchanged, so don't count on it in this task. Briefs show pending and \
             declined proposals, so it won't be proposed twice.",
            p.id
        ))
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
        TaskState::Waiting => "waiting for the user's answers",
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
fn brief(
    t: &Task,
    changes: &[atelier_proto::FileChange],
    batches: &[atelier_proto::Batch],
    stats: &atelier_proto::CallStats,
    proposals: &[atelier_proto::Proposal],
) -> String {
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
    for a in &t.brief.attachments {
        let what = if a.ends_with(".jpg") || a.ends_with(".png") {
            "a screenshot of the page as the user saw it when asking; look at it with your file tools"
        } else {
            "read it with your file tools"
        };
        let _ = writeln!(out, "Attached: {a} ({what})");
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
         Edit files there with your file tools (give them the tree as the directory to work in, e.g. Glob's path, \
         since your working directory is elsewhere). Tabs you open with tab_open show the tree's styles and pick \
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
                let _ = writeln!(out, "- {}.", present.join(", "));
            }
            // Other themes' styles for this site: the best map of how it works.
            let others: Vec<String> =
                std::fs::read_dir(std::path::Path::new(tree).join("services").join(s))
                    .into_iter()
                    .flatten()
                    .flatten()
                    .filter(|e| e.path().is_dir())
                    .filter_map(|e| e.file_name().to_str().map(str::to_string))
                    .filter(|d| d != theme && d != "variants")
                    .filter(|d| exists(&format!("services/{s}/{d}/")))
                    .collect();
            for other in others {
                let _ = writeln!(
                    out,
                    "- services/{s}/{other}/: this site's styles for another theme. They're a map of how the \
                     site works (which tokens and scopes it has, which selectors are stable, its quirks), and \
                     can save much of the discovery work. Their look is that theme's, though: don't carry its \
                     design decisions over, and check what you reuse against the page."
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
    if !batches.is_empty() {
        out.push_str("\n## Calls put to the user\n");
        for b in batches.iter().rev() {
            out.push_str(&batch_text(b));
        }
        out.push_str(
            "\nIf an answer settles something that will matter beyond this task, record it so nobody asks \
             again: in the service's notes.md if it's about this site; if it's about the theme, propose it for \
             THEME.md with theme_propose (unless a proposal below already covers it).\n",
        );
    }
    out.push_str(&pages_section(tree, t.service.as_deref()));
    out.push_str(HOW_TO_WORK);
    out.push_str(&asking(&theme_stage(tree, theme), stats));
    if !proposals.is_empty() {
        out.push_str("\n## Proposed changes to THEME.md\n\n");
        for p in proposals {
            match p.state {
                atelier_proto::ProposalState::Open => {
                    let _ = writeln!(out, "- Waiting for the user: {}", p.summary);
                }
                _ => {
                    let note = p
                        .note
                        .as_deref()
                        .map(|n| format!(" (they said: {n})"))
                        .unwrap_or_default();
                    let _ = writeln!(out, "- Declined by the user: {}{note}", p.summary);
                }
            }
        }
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
         once it has loaded; if it matches nothing, the toolbar button shows a badge and the description. \
         Also `[[pages]]`, the site's representative pages: `url`, `what` it shows, and `states` worth \
         checking on it.\n\
         - services/<service>/notes.md: for whoever works on this service next. Keep how the site works \
         (its structure, tokens and quirks, true for every theme) apart from decisions about the look, which \
         go under a heading for the theme (## {theme}).\n\
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

/// The theme's stage (SPEC §9.5), from themes/<theme>/theme.toml in the
/// tree: `forming` unless the user says `settled`.
fn theme_stage(tree: &str, theme: &str) -> String {
    std::fs::read_to_string(std::path::Path::new(tree).join(format!("themes/{theme}/theme.toml")))
        .ok()
        .and_then(|t| t.parse::<toml::Table>().ok())
        .and_then(|t| t.get("stage")?.as_str().map(str::to_string))
        .filter(|s| s == "settled")
        .unwrap_or_else(|| "forming".into())
}

/// How readily to put calls to the user, by the theme's stage.
fn asking(stage: &str, stats: &atelier_proto::CallStats) -> String {
    let mut out = String::from("\n## How readily to ask\n\n");
    if stage == "settled" {
        out.push_str(
            "The user has marked this theme **settled**. That isn't them saying your assignment is free of \
             ambiguity; it's them saying they expect to be satisfied with whatever provisional calls you make. \
             So make your calls, and record them (task_ask with wait: record, or `assumptions` when you \
             submit). Ask before landing only if you think the user would be unhappy with any call you could \
             make on your own, or the site is territory the theme doesn't cover.\n",
        );
    } else {
        out.push_str(
            "This theme is **forming**: the user is still working out what they want, and questions help. \
             Answers to questions about the theme improve THEME.md for every task after this one. So where \
             the theme leaves something open, or you'd be guessing at the user's taste, put it to them rather \
             than deciding quietly: gather calls, and at a natural checkpoint (a first pass, with screenshots) \
             send them with task_ask, saying what you'd choose. Calls about the theme as a whole are the most \
             valuable thing a session on a forming theme produces, because every later site benefits: post \
             them even when nothing blocks you, and propose THEME.md wording (theme_propose) for the \
             interpretations you settled on, so the user can confirm or correct them. Most can be for the record (you go ahead; a \
             different answer reopens it); keep review for the ones where the options would mean substantially \
             different work.\n",
        );
    }
    if stats.answered >= 5 {
        let _ = writeln!(
            out,
            "\nSo far on this theme, the user kept {} of the {} calls they answered that came with a choice.",
            stats.kept, stats.answered
        );
    }
    out
}

/// A batch of calls, with answers if it has them, as briefs show it.
fn batch_text(b: &atelier_proto::Batch) -> String {
    let mut out = String::new();
    let wait = match b.wait {
        atelier_proto::Wait::Record => "for the record",
        atelier_proto::Wait::Review => "for review",
        atelier_proto::Wait::Block => "blocking",
    };
    let status = if b.answered.is_some() {
        "answered"
    } else {
        "not answered yet"
    };
    let _ = writeln!(out, "\n{} ({wait}, {status}):", b.id);
    for c in &b.calls {
        let _ = write!(out, "- {}", c.question);
        if c.wait.is_some_and(|w| w != b.wait) {
            let _ = write!(out, " (for the record)");
        }
        if let Some(choice) = &c.choice {
            let _ = write!(out, " [your call: {choice}]");
        }
        match &c.answer {
            Some(a) if a.kept => {
                let _ = write!(out, " → kept");
            }
            Some(a) => {
                if let Some(ch) = a
                    .choice
                    .as_ref()
                    .filter(|ch| Some(*ch) != c.choice.as_ref())
                {
                    let _ = write!(out, " → the user chose: {ch}");
                    if a.applied {
                        let _ = write!(out, " (already written into the style)");
                    }
                }
                if let Some(n) = &a.note {
                    let _ = write!(out, " → the user said: {n}");
                }
            }
            None => {}
        }
        out.push('\n');
    }
    out
}

/// The representative pages a service lists in service.toml (`[[pages]]`):
/// url, what it shows, and states worth checking on it.
fn service_pages(tree: &str, service: &str) -> Vec<(String, String, Vec<String>)> {
    let path = std::path::Path::new(tree).join(format!("services/{service}/service.toml"));
    let Some(table) = std::fs::read_to_string(path)
        .ok()
        .and_then(|t| t.parse::<toml::Table>().ok())
    else {
        return Vec::new();
    };
    table
        .get("pages")
        .and_then(|p| p.as_array())
        .into_iter()
        .flatten()
        .filter_map(|p| {
            let url = p.get("url")?.as_str()?.to_string();
            let what = p
                .get("what")
                .and_then(|w| w.as_str())
                .unwrap_or("")
                .to_string();
            let states = p
                .get("states")
                .and_then(|s| s.as_array())
                .into_iter()
                .flatten()
                .filter_map(|s| s.as_str().map(str::to_string))
                .collect();
            Some((url, what, states))
        })
        .collect()
}

/// The brief's section on which pages to check.
fn pages_section(tree: &str, service: Option<&str>) -> String {
    let mut out = String::from("\n## Pages to check\n\n");
    let pages = service.map(|s| service_pages(tree, s)).unwrap_or_default();
    if pages.is_empty() {
        out.push_str(
            "There's no list of this site's representative pages yet. As you work, add one to service.toml \
             ([[pages]] with url, what, and states worth checking, such as a menu open or a focused input), \
             covering the kinds of page and state the styles reach, including ones you couldn't see (logged-in \
             pages, say). It's how the next agent knows what to check, and what health checks will look at.\n",
        );
    } else {
        out.push_str(
            "service.toml lists these as the site's representative pages. Check your styles on each, in the \
             states given; where you can't (a logged-in page in a logged-out browser, say), say so in your \
             summary rather than leaving it to be assumed. Add pages you find that the list is missing.\n\n",
        );
        for (url, what, states) in pages {
            let states = if states.is_empty() {
                String::new()
            } else {
                format!(" (states: {})", states.join(", "))
            };
            let _ = writeln!(out, "- {what}: {url}{states}");
        }
    }
    out
}

/// How to do the work: what has worked well, with the reasons, so agents can
/// tell when a heuristic doesn't fit. Part of every brief, since harnesses
/// truncate server instructions (see INSTRUCTIONS in mcp.rs).
const HOW_TO_WORK: &str = "\n## How to work\n\n\
What has worked well when styling a site, with the reasons, so you can tell when one doesn't fit and \
depart from it (say why in your summary if you do):\n\n\
- Start with css_tokens. Most sites built in the last few years have design tokens (CSS custom \
properties), and overriding them restyles a site far more thoroughly than restyling components one by \
one, and keeps working when components change. Cover the nested scopes that re-declare tokens too.\n\
- If the site has its own dark (or light) mode close to what the theme wants, build on it, and record it as \
a prerequisite in service.toml with a `check` selector that matches only when it's on, so the user is told \
when it isn't.\n\
- Prefer stable hooks (ids, aria and data-* attributes, readable class names) to generated class names, \
which change on every deploy. And remember that a short selector can still reach a long way: check broad \
rules beyond the pages you started from.\n\
- Set link and text colours explicitly: sites leave some to the browser defaults, which are unreadable on \
a dark theme.\n\
- Split a service's styles along natural seams (base, editor, settings), so one that breaks can be turned \
off without losing the rest.\n\
- Check your work beyond screenshots: contrast_scan finds text that doesn't stand out against its \
background, shape_scan finds what's still drawn as a box, force_state shows hover and focus styles, and \
styles_status reports problems loading your files (a style with errors keeps its last good version \
applied, so a mistake can look as if nothing happened).\n\
- Work in the task's tree, not the owned directory: only landings are recorded, undoable, and passed to \
the user's hooks.\n\
- When a limit of atelier or the browser stops you (a part of the page your styles can't reach, a tool \
that can't see something), that's a limit to fix, not a decision about the look: say so in your summary \
and notes.md, and in feedback on the tools, rather than proposing it for THEME.md or quietly lowering \
the bar.\n\n\
For a this-or-that question about part of a style, show the user both. Quickest: screenshots of each \
(screenshot's extraCss shows a variant without editing files; attach: true saves it for task_ask). \
Better, when the choice matters: mark the part in the style file with the comments \
`/* atelier:variant NAME */` and `/* atelier:end NAME */` around your choice, put each option's CSS (yours \
too) in variants/NAME/<option>.css beside the style file, and give the call `variant: NAME`. The user can \
then flip between the options live in their own tab, and picking another one writes it into the style \
for you, even after the work has landed.\n";
