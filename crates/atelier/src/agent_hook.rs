//! `atelier agent-hook stop|prompt`: Claude Code hooks for sessions started
//! by atelier-agent (SPEC §9.1), which ends a session once its work is done,
//! so finished sessions (and their windows) don't pile up.
//!
//! Claude Code runs `prompt` on UserPromptSubmit and `stop` on Stop, with
//! the event as JSON on stdin; atelier-agent exports ATELIER_AGENT_PID (the
//! harness's process, which its `atelier mcp` is named after). At a stop:
//!
//! - if the user has said anything to the session beyond the work prompt,
//!   it's theirs, and stays open;
//! - if it holds a task, it's mid-work, and stays open;
//! - if the queue has requests waiting, the agent is asked to carry on (once:
//!   if it stops again, it stays open, for whoever looks);
//! - otherwise it's done, and the harness is ended (SIGTERM), a moment later.

use crate::{cli::Client, mcp, paths};
use atelier_proto::{Role, Task, TaskState, task_method};
use serde_json::{Value, json};
use std::fs;
use std::io::Read;
use std::os::unix::process::CommandExt;
use std::path::Path;
use std::process::{Command, ExitCode, Stdio};

/// How the work prompt starts, so it isn't counted as the user talking.
const WORK_PROMPT_START: &str = "I'd like your help with atelier's queue.";

pub fn run(dir: Option<&str>, args: &[String]) -> ExitCode {
    let mut input = String::new();
    let _ = std::io::stdin().read_to_string(&mut input);
    let event: Value = serde_json::from_str(&input).unwrap_or(Value::Null);
    // Outside atelier-agent there's nothing to do; a hook never fails the harness.
    let Some(pid) = mcp::agent_pid() else {
        return ExitCode::SUCCESS;
    };
    let dir = paths::atelier_dir(dir);
    let session = event["session_id"]
        .as_str()
        .unwrap_or_default()
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-')
        .collect::<String>();
    let talked = paths::state_dir(&dir)
        .join("agents")
        .join(if session.is_empty() {
            format!("{pid}.talked")
        } else {
            format!("{session}.talked")
        });
    match args.first().map(String::as_str) {
        Some("prompt") => {
            let prompt = event["prompt"].as_str().unwrap_or_default();
            if !prompt.trim_start().starts_with(WORK_PROMPT_START) {
                let _ = fs::create_dir_all(talked.parent().expect("has parent"));
                let _ = fs::write(&talked, b"");
            }
        }
        Some("stop") => {
            if talked.exists() {
                return ExitCode::SUCCESS;
            }
            match decide(&dir, pid, event["stop_hook_active"] == json!(true)) {
                Decision::Stay => {}
                Decision::CarryOn(reason) => {
                    println!("{}", json!({ "decision": "block", "reason": reason }));
                }
                Decision::End => end(pid),
            }
        }
        _ => {
            eprintln!(
                "usage: atelier agent-hook stop|prompt (run by Claude Code, with the event on stdin)"
            );
            return ExitCode::FAILURE;
        }
    }
    ExitCode::SUCCESS
}

enum Decision {
    Stay,
    CarryOn(String),
    End,
}

fn decide(dir: &Path, pid: u32, asked_already: bool) -> Decision {
    let Ok(Some((mut client, _))) = Client::connect(dir, Role::Cli) else {
        return Decision::Stay;
    };
    let Ok(tasks) = client
        .call(task_method::LIST, json!({}))
        .and_then(|v| serde_json::from_value::<Vec<Task>>(v).map_err(std::io::Error::other))
    else {
        return Decision::Stay;
    };
    let me = format!("agent-{pid}");
    let holding = tasks.iter().any(|t| {
        t.state == TaskState::Claimed && t.lease.as_ref().is_some_and(|l| l.session == me)
    });
    if holding {
        return Decision::Stay;
    }
    let queued = tasks
        .iter()
        .filter(|t| t.state == TaskState::Queued)
        .count();
    if queued > 0 {
        return if asked_already {
            Decision::Stay
        } else {
            Decision::CarryOn(format!(
                "atelier's queue has {queued} more request{} waiting (task_list). Please carry on with them, \
                 unless something stops you; then say what.",
                if queued == 1 { "" } else { "s" }
            ))
        };
    }
    Decision::End
}

/// Ends the harness a moment after this hook returns, so its last message
/// is written out first. Only a process this hook is running under: a
/// stale or wrong ATELIER_AGENT_PID never ends anything else.
fn end(pid: u32) {
    if !is_ancestor(pid) {
        eprintln!("atelier agent-hook: {pid} isn't this session's harness; leaving it");
        return;
    }
    let _ = Command::new("sh")
        .arg("-c")
        .arg(format!("sleep 2; kill -TERM {pid}"))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .process_group(0)
        .spawn();
}

/// Whether `pid` is this process or one of its ancestors.
fn is_ancestor(pid: u32) -> bool {
    let mut p = std::process::id();
    for _ in 0..64 {
        if p == pid {
            return true;
        }
        let Ok(stat) = fs::read_to_string(format!("/proc/{p}/stat")) else {
            return false;
        };
        // The parent is the second field after the command, which is in parentheses.
        let Some(ppid) = stat
            .rsplit_once(')')
            .and_then(|(_, rest)| rest.split_whitespace().nth(1)?.parse().ok())
        else {
            return false;
        };
        if ppid <= 1 {
            return false;
        }
        p = ppid;
    }
    false
}
