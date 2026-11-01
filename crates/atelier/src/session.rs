//! Starting agent sessions (SPEC §9.1).
//!
//! atelier doesn't know about terminals or harnesses. The user configures a
//! command in config.toml, and when there's work the user asked for and no
//! session is working the queue, the daemon runs it:
//!
//! ```toml
//! [session]
//! start = "spawn"     # or "pull" (the default: never start one), or "headless"
//! command = 'foot -D {dir} -e claude "$(atelier work-prompt)"'
//! ```
//!
//! `command` is a string, run with `sh -c` after its placeholders are
//! replaced by shell-quoted values, or an array, run directly with each
//! placeholder replaced as is. Placeholders: `{dir}` (the owned directory),
//! `{state}` (its state directory, where task trees are: harnesses that
//! confine edits to a directory need it, e.g. Claude Code's `--add-dir`),
//! and `{task}` (the task that prompted it, or empty). The command also gets
//! ATELIER_DIR, ATELIER_TASK_ID and ATELIER_SESSION (`spawn` or `headless`)
//! in its environment; `atelier mcp` reads the last one, so a headless agent
//! knows nobody is there to answer.

use crate::paths;
use std::fs;
use std::path::Path;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant, SystemTime};

/// After launching, assume the session is on its way for this long, so a
/// burst of requests starts one session rather than several.
const STARTING_FOR: Duration = Duration::from_secs(180);
/// A session that called task_claim this recently is waiting for work.
const WAITING_FOR: Duration = Duration::from_secs(15);
/// session.log is started afresh (the old one kept as session.log.old) once
/// it's this big.
const LOG_MAX: u64 = 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Start {
    Pull,
    Spawn,
    Headless,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Template {
    Shell(String),
    Argv(Vec<String>),
}

#[derive(Debug, Clone)]
pub struct Config {
    pub start: Start,
    pub command: Option<Template>,
    /// Agent tabs open in a window per session rather than in the user's
    /// current window (`windows = true`).
    pub windows: bool,
}

/// Reads `[session]` from config.toml. A missing file or table means pull.
pub fn config() -> Result<Config, String> {
    let path = paths::config_path();
    let text = match fs::read_to_string(&path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(e) => return Err(format!("{}: {e}", path.display())),
    };
    let table: toml::Table = text
        .parse()
        .map_err(|e| format!("{}: {e}", path.display()))?;
    let Some(session) = table.get("session") else {
        return Ok(Config {
            start: Start::Pull,
            command: None,
            windows: false,
        });
    };
    let start = match session.get("start").and_then(|v| v.as_str()) {
        None | Some("pull") => Start::Pull,
        Some("spawn") => Start::Spawn,
        Some("headless") => Start::Headless,
        Some(other) => {
            return Err(format!(
                "{}: [session] start = \"{other}\" isn't one of pull, spawn, headless",
                path.display()
            ));
        }
    };
    let command = match session.get("command") {
        None => None,
        Some(toml::Value::String(s)) => Some(Template::Shell(s.clone())),
        Some(toml::Value::Array(a)) => Some(Template::Argv(
            a.iter()
                .map(|v| v.as_str().map(str::to_string))
                .collect::<Option<Vec<_>>>()
                .ok_or_else(|| {
                    format!(
                        "{}: [session] command must be a string or an array of strings",
                        path.display()
                    )
                })?,
        )),
        Some(_) => {
            return Err(format!(
                "{}: [session] command must be a string or an array of strings",
                path.display()
            ));
        }
    };
    if start != Start::Pull && command.is_none() {
        return Err(format!(
            "{}: [session] start = \"{}\" needs a `command` to run",
            path.display(),
            if start == Start::Spawn {
                "spawn"
            } else {
                "headless"
            }
        ));
    }
    let windows = match session.get("windows") {
        None => false,
        Some(toml::Value::Boolean(b)) => *b,
        Some(_) => {
            return Err(format!(
                "{}: [session] windows must be true or false",
                path.display()
            ));
        }
    };
    Ok(Config {
        start,
        command,
        windows,
    })
}

/// Quotes a value for `sh`.
fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

/// The program and arguments to run.
pub fn render(template: &Template, dir: &Path, task: Option<&str>) -> Vec<String> {
    let state = paths::state_dir(dir).display().to_string();
    let dir = dir.display().to_string();
    let task = task.unwrap_or_default();
    let fill = |s: &str, quote: fn(&str) -> String| {
        s.replace("{dir}", &quote(&dir))
            .replace("{state}", &quote(&state))
            .replace("{task}", &quote(task))
    };
    match template {
        Template::Shell(s) => vec!["sh".into(), "-c".into(), fill(s, shell_quote)],
        Template::Argv(a) => a.iter().map(|arg| fill(arg, str::to_string)).collect(),
    }
}

/// What the daemon knows about sessions, for deciding whether to start one.
/// The last launch is also written to `launched` in the state directory, so
/// a daemon that restarts while a session is starting doesn't start another.
#[derive(Default)]
pub struct Launcher {
    launched: Option<SystemTime>,
    polled: Option<Instant>,
    /// Where the last launch is recorded (None in tests).
    record: Option<PathBuf>,
}

impl Launcher {
    pub fn new(state_dir: &Path) -> Launcher {
        let record = state_dir.join("launched");
        let launched = fs::read_to_string(&record)
            .ok()
            .and_then(|t| t.trim().parse::<u64>().ok())
            .map(|ms| SystemTime::UNIX_EPOCH + Duration::from_millis(ms));
        Launcher {
            launched,
            polled: None,
            record: Some(record),
        }
    }

    fn set_launched(&mut self, at: Option<SystemTime>) {
        self.launched = at;
        let Some(record) = &self.record else { return };
        let written = match at {
            Some(t) => fs::write(
                record,
                t.duration_since(SystemTime::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_millis()
                    .to_string(),
            ),
            None => match fs::remove_file(record) {
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
                other => other,
            },
        };
        if let Err(e) = written {
            eprintln!("atelier daemon: {}: {e}", record.display());
        }
    }

    /// A session asked for work (and may be waiting for more).
    pub fn polled(&mut self) {
        self.polled = Some(Instant::now());
    }

    /// A session claimed a task: whatever was launched has arrived.
    pub fn claimed(&mut self) {
        if self.launched.is_some() {
            self.set_launched(None);
        }
    }

    /// A session asked for work recently.
    pub fn waiting(&self) -> bool {
        self.polled.is_some_and(|t| t.elapsed() < WAITING_FOR)
    }

    /// A session was launched recently and hasn't claimed anything yet.
    pub fn starting(&self) -> bool {
        self.launched
            .is_some_and(|t| t.elapsed().unwrap_or_default() < STARTING_FOR)
    }

    /// Why a new session shouldn't be started now, if there's a reason.
    pub fn busy(&self, tasks_in_progress: bool) -> Option<&'static str> {
        if tasks_in_progress {
            Some("a session is working on a task, and will see the queue when it's done")
        } else if self.waiting() {
            Some("a session is waiting for work")
        } else if self.starting() {
            Some("a session was started recently and hasn't claimed anything yet")
        } else {
            None
        }
    }

    /// Runs the command, detached: it outlives the daemon, and its output
    /// goes to session.log in the state directory. Returns the command line.
    pub fn launch(
        &mut self,
        config: &Config,
        dir: &Path,
        task: Option<&str>,
    ) -> Result<String, String> {
        let template = config
            .command
            .as_ref()
            .ok_or("no [session] command is configured in config.toml")?;
        let argv = render(template, dir, task);
        let log_path = paths::state_dir(dir).join("session.log");
        if fs::metadata(&log_path).is_ok_and(|m| m.len() > LOG_MAX) {
            let _ = fs::rename(&log_path, log_path.with_extension("log.old"));
        }
        let log = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&log_path)
            .map_err(|e| format!("{}: {e}", log_path.display()))?;
        let mode = if config.start == Start::Headless {
            "headless"
        } else {
            "spawn"
        };
        let mut command = Command::new(&argv[0]);
        command
            .args(&argv[1..])
            .current_dir(dir)
            .env("ATELIER_DIR", dir)
            .env("ATELIER_TASK_ID", task.unwrap_or_default())
            .env("ATELIER_SESSION", mode)
            .stdin(Stdio::null())
            .stdout(log.try_clone().map_err(|e| e.to_string())?)
            .stderr(log);
        {
            use std::os::unix::process::CommandExt;
            // Its own process group, so it isn't taken down with the daemon.
            command.process_group(0);
        }
        let mut child = command
            .spawn()
            .map_err(|e| format!("couldn't run `{}`: {e}", argv[0]))?;
        self.set_launched(Some(SystemTime::now()));
        let line = argv.join(" ");
        let shown = line.clone();
        std::thread::spawn(move || match child.wait() {
            Ok(s) if s.success() => {}
            Ok(s) => eprintln!("atelier daemon: session command exited with {s}: {shown}"),
            Err(e) => eprintln!("atelier daemon: session command: {e}"),
        });
        Ok(line)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shell_templates_quote_placeholders() {
        let argv = render(
            &Template::Shell("foot -D {dir} -e claude \"/mcp__atelier__work\" # {task}".into()),
            Path::new("/home/a b/it's"),
            Some("t1"),
        );
        assert_eq!(argv[..2], ["sh", "-c"]);
        assert_eq!(
            argv[2],
            r#"foot -D '/home/a b/it'\''s' -e claude "/mcp__atelier__work" # 't1'"#
        );
    }

    #[test]
    fn argv_templates_substitute_without_quoting() {
        let argv = render(
            &Template::Argv(vec!["kitty".into(), "--directory={dir}".into()]),
            Path::new("/home/a b"),
            None,
        );
        assert_eq!(argv, ["kitty", "--directory=/home/a b"]);
    }

    #[test]
    fn a_recent_launch_or_waiting_session_holds_off_another() {
        let mut l = Launcher::default();
        assert_eq!(l.busy(false), None);
        assert!(l.busy(true).is_some());
        l.launched = Some(SystemTime::now());
        assert!(l.busy(false).unwrap().contains("started recently"));
        l.claimed();
        assert_eq!(l.busy(false), None);
        l.polled();
        assert!(l.busy(false).unwrap().contains("waiting"));
    }

    #[test]
    fn a_launch_is_remembered_across_restarts() {
        let tmp = tempfile::tempdir().unwrap();
        let mut l = Launcher::new(tmp.path());
        l.set_launched(Some(SystemTime::now()));
        assert!(Launcher::new(tmp.path()).busy(false).is_some());
        l.claimed();
        assert_eq!(Launcher::new(tmp.path()).busy(false), None);
    }
}
