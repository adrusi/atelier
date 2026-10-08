//! Tasks, landing and the undo journal (SPEC §8).
//!
//! A task is a piece of work on the owned directory. Claiming it copies the
//! owned directory into the task's own tree and records a hash of every file
//! (the base). The agent edits the tree. Submitting diffs the tree against the
//! base, checks the changes (scope, lint, and that nothing changed underneath
//! them), records the old contents in the journal, and writes the changes into
//! the owned directory atomically. The journal makes every landing undoable.
//!
//! Everything lives under the state directory (SPEC §7) as plain files; the
//! daemon is the only writer.

use crate::loader;

mod calls;
mod proposals;
use atelier_proto::{
    ChangeKind, FileChange, JournalEntry, Lease, Severity, SubmitProblem, SubmitResult, Task,
    TaskCreateParams, TaskKind, TaskOutcome, TaskState,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

/// How long a claim lasts without a heartbeat.
pub const LEASE_MS: u64 = 10 * 60 * 1000;
/// The journal keeps at least this many entries, and anything younger than JOURNAL_MAX_AGE_MS.
const JOURNAL_KEEP: usize = 50;
const JOURNAL_MAX_AGE_MS: u64 = 90 * 24 * 60 * 60 * 1000;
/// The largest file a request may attach.
const MAX_ATTACHMENT: usize = 16 * 1024 * 1024;
/// Conflicting files are sent back to the agent in full up to this size.
const MAX_CONFLICT_TEXT: u64 = 256 * 1024;

pub type Result<T> = std::result::Result<T, String>;

pub struct Store {
    /// The owned directory.
    dir: PathBuf,
    /// This owned directory's state directory.
    state: PathBuf,
}

/// What the journal stores for an entry, beyond what clients see.
#[derive(Serialize, Deserialize)]
struct JournalRecord {
    entry: JournalEntry,
    /// For each file: whether it existed before the change (its old contents
    /// are under `before/` if so), and its hash after (None: deleted; its new
    /// contents are under `after/` otherwise).
    files: BTreeMap<String, FileRecord>,
    /// False while the entry is only an intent: written down, but not yet
    /// fully made (see `finish`). Entries from before intents were complete.
    #[serde(default = "complete_by_default")]
    complete: bool,
    /// What else the change does, once its files are written.
    #[serde(default)]
    then: Vec<Followup>,
}

fn complete_by_default() -> bool {
    true
}

/// The rest of a change, after its files: done by `finish`, and so redone by
/// recovery if atelier stopped first.
#[derive(Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
enum Followup {
    /// A task landed.
    Landed {
        task: String,
        service: Option<String>,
        outcome: TaskOutcome,
    },
    /// This entry undid another.
    Undid { seq: u64 },
    /// A proposal to THEME.md was accepted.
    Accepted { proposal: String },
}

/// Stops the process here if ATELIER_CRASH_AT names this point: for tests
/// that check recovery from a crash partway through a change.
fn crash_point(name: &str) {
    if std::env::var("ATELIER_CRASH_AT").as_deref() == Ok(name) {
        eprintln!("atelier: stopping at {name} (ATELIER_CRASH_AT)");
        std::process::exit(86);
    }
}

#[derive(Serialize, Deserialize)]
struct FileRecord {
    existed: bool,
    after: Option<String>,
}

impl Store {
    pub fn new(dir: &Path, state: &Path) -> io::Result<Store> {
        fs::create_dir_all(state.join("tasks"))?;
        fs::create_dir_all(state.join("journal"))?;
        Ok(Store {
            dir: dir.to_path_buf(),
            state: state.to_path_buf(),
        })
    }

    fn task_dir(&self, id: &str) -> PathBuf {
        self.state.join("tasks").join(id)
    }

    fn save(&self, task: &Task) -> Result<()> {
        let dir = self.task_dir(&task.id);
        fs::create_dir_all(&dir).map_err(err)?;
        write_atomic(
            &dir.join("task.json"),
            serde_json::to_string_pretty(task).map_err(err)?.as_bytes(),
        )
        .map_err(err)
    }

    pub fn get(&self, id: &str) -> Result<Task> {
        if id.is_empty() || id.contains(['/', '.']) {
            return Err(format!("no task `{id}`"));
        }
        let text = fs::read_to_string(self.task_dir(id).join("task.json"))
            .map_err(|_| format!("no task `{id}`"))?;
        serde_json::from_str(&text).map_err(err)
    }

    pub fn create(
        &self,
        params: TaskCreateParams,
        theme: Option<String>,
        now: u64,
    ) -> Result<Task> {
        if params.brief.description.trim().is_empty() {
            return Err("a task needs a description of what's wanted".into());
        }
        if let Some(s) = &params.service {
            check_name("service", s)?;
        }
        let id = new_id(now);
        let mut brief = params.brief;
        brief.attachments = Vec::new();
        for upload in &params.uploads {
            brief.attachments.push(self.attach(&id, upload)?);
        }
        let task = Task {
            id,
            kind: params.kind,
            service: params.service,
            theme,
            brief,
            state: TaskState::Queued,
            lease: None,
            tree: None,
            handoff: None,
            created: now,
            updated: now,
            outcome: None,
        };
        self.save(&task)?;
        Ok(task)
    }

    /// Stores a file that came with a request in the task's directory, and
    /// returns its path.
    fn attach(&self, id: &str, upload: &atelier_proto::Upload) -> Result<String> {
        use base64::Engine;
        let name: String = upload
            .name
            .chars()
            .map(|c| {
                if c.is_ascii_alphanumeric() || "._-".contains(c) {
                    c
                } else {
                    '_'
                }
            })
            .take(64)
            .collect();
        if name.is_empty() || name.starts_with('.') {
            return Err(format!("`{}` isn't a usable attachment name", upload.name));
        }
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(&upload.data)
            .map_err(|e| format!("attachment {name}: {e}"))?;
        if bytes.len() > MAX_ATTACHMENT {
            return Err(format!(
                "attachment {name} is {} bytes; the limit is {MAX_ATTACHMENT}",
                bytes.len()
            ));
        }
        let path = self.task_dir(id).join("attachments").join(&name);
        fs::create_dir_all(path.parent().expect("has parent")).map_err(err)?;
        write_atomic(&path, &bytes).map_err(err)?;
        Ok(path.display().to_string())
    }

    /// All tasks, oldest first, after returning expired claims to the queue.
    pub fn list(&self, state: Option<TaskState>, now: u64) -> Result<Vec<Task>> {
        let mut tasks = Vec::new();
        for entry in fs::read_dir(self.state.join("tasks"))
            .map_err(err)?
            .flatten()
        {
            let Some(id) = entry.file_name().to_str().map(str::to_string) else {
                continue;
            };
            let Ok(mut task) = self.get(&id) else {
                continue;
            };
            if self.expire(&mut task, now)? {
                self.save(&task)?;
            }
            if state.is_none_or(|s| s == task.state) {
                tasks.push(task);
            }
        }
        tasks.sort_by(|a, b| (a.created, &a.id).cmp(&(b.created, &b.id)));
        Ok(tasks)
    }

    /// Returns a claimed task to the queue if its lease ran out. Its tree is
    /// kept, so whoever claims it next carries on where it was left.
    fn expire(&self, task: &mut Task, now: u64) -> Result<bool> {
        if task.state == TaskState::Claimed && task.lease.as_ref().is_some_and(|l| l.expires < now)
        {
            // A task held while the user answers parks if the hold runs out.
            task.state = if self.awaits_answers(&task.id)? {
                TaskState::Waiting
            } else {
                TaskState::Queued
            };
            task.lease = None;
            task.updated = now;
            return Ok(true);
        }
        Ok(false)
    }

    /// Claims a task (the oldest queued one, unless `id` is given), copying the
    /// owned directory into its tree the first time.
    pub fn claim(&self, id: Option<&str>, session: &str, now: u64) -> Result<Option<Task>> {
        let mut task = match id {
            Some(id) => {
                let mut t = self.get(id)?;
                self.expire(&mut t, now)?;
                t
            }
            None => match self.list(Some(TaskState::Queued), now)?.into_iter().next() {
                Some(t) => t,
                None => return Ok(None),
            },
        };
        match task.state {
            TaskState::Queued => {}
            TaskState::Claimed if task.lease.as_ref().is_some_and(|l| l.session == session) => {}
            TaskState::Claimed => {
                return Err(format!(
                    "task {} is claimed by another session until its lease runs out",
                    task.id
                ));
            }
            other => {
                return Err(format!(
                    "task {} is {}, so it can't be claimed",
                    task.id,
                    state_name(other)
                ));
            }
        }
        let tree = self.task_dir(&task.id).join("tree");
        if !tree.exists() {
            let base = copy_tree(&self.dir, &tree).map_err(err)?;
            write_atomic(
                &self.task_dir(&task.id).join("base.json"),
                serde_json::to_string_pretty(&base).map_err(err)?.as_bytes(),
            )
            .map_err(err)?;
        }
        task.state = TaskState::Claimed;
        task.lease = Some(Lease {
            session: session.to_string(),
            expires: now + LEASE_MS,
        });
        task.tree = Some(tree.display().to_string());
        task.updated = now;
        self.save(&task)?;
        Ok(Some(task))
    }

    fn held(&self, id: &str, session: &str, now: u64) -> Result<Task> {
        let mut task = self.get(id)?;
        self.expire(&mut task, now)?;
        match (&task.state, &task.lease) {
            (TaskState::Claimed, Some(l)) if l.session == session => Ok(task),
            // The lease ran out but nobody else took it: carry on.
            (TaskState::Queued, None) if task.tree.is_some() => Ok(task),
            (TaskState::Claimed, _) => Err(format!("task {id} is claimed by another session")),
            (s, _) => Err(format!(
                "task {id} is {}, not claimed by this session",
                state_name(*s)
            )),
        }
    }

    pub fn heartbeat(&self, id: &str, session: &str, now: u64) -> Result<Task> {
        let mut task = self.held(id, session, now)?;
        task.state = TaskState::Claimed;
        task.lease = Some(Lease {
            session: session.to_string(),
            expires: now + LEASE_MS,
        });
        task.updated = now;
        self.save(&task)?;
        Ok(task)
    }

    pub fn decline(&self, id: &str, session: &str, reason: &str, now: u64) -> Result<Task> {
        let mut task = self.held(id, session, now)?;
        task.state = TaskState::Declined;
        task.lease = None;
        task.outcome = Some(TaskOutcome::Declined {
            reason: reason.to_string(),
        });
        task.updated = now;
        self.save(&task)?;
        Ok(task)
    }

    /// Puts a task back in the queue, keeping its tree, with a note for
    /// whoever claims it next.
    pub fn release(&self, id: &str, session: &str, handoff: &str, now: u64) -> Result<Task> {
        let mut task = self.held(id, session, now)?;
        task.state = TaskState::Queued;
        task.lease = None;
        task.handoff = Some(handoff.trim().to_string()).filter(|h| !h.is_empty());
        task.updated = now;
        self.save(&task)?;
        Ok(task)
    }

    /// Sets the handoff note of a task nobody is working on.
    pub fn note(&self, id: &str, handoff: &str, now: u64) -> Result<Task> {
        let mut task = self.get(id)?;
        if !matches!(task.state, TaskState::Queued | TaskState::Waiting) {
            return Err(format!(
                "task {id} is {}, so it takes no handoff note",
                state_name(task.state)
            ));
        }
        task.handoff = Some(handoff.trim().to_string()).filter(|h| !h.is_empty());
        task.updated = now;
        self.save(&task)?;
        Ok(task)
    }

    /// How a claimed task's tree differs from when it was claimed.
    pub fn changes(&self, id: &str) -> Result<Vec<FileChange>> {
        let task = self.get(id)?;
        if task.tree.is_none() {
            return Ok(Vec::new());
        }
        let base: BTreeMap<String, String> = serde_json::from_str(
            &fs::read_to_string(self.task_dir(id).join("base.json")).map_err(err)?,
        )
        .map_err(err)?;
        Ok(diff(
            &base,
            &hash_tree(&self.task_dir(id).join("tree")).map_err(err)?,
        ))
    }

    pub fn abandon(&self, id: &str, reason: &str, now: u64) -> Result<Task> {
        let mut task = self.get(id)?;
        if matches!(
            task.state,
            TaskState::Landed | TaskState::Declined | TaskState::Abandoned
        ) {
            return Err(format!("task {id} is already {}", state_name(task.state)));
        }
        task.state = TaskState::Abandoned;
        task.lease = None;
        task.outcome = Some(TaskOutcome::Abandoned {
            reason: reason.to_string(),
        });
        task.updated = now;
        self.save(&task)?;
        Ok(task)
    }

    /// Lands a task's changes, or explains why not (SPEC §8.4).
    pub fn submit(
        &self,
        id: &str,
        session: &str,
        summary: &str,
        assumptions: Vec<String>,
        vars: &BTreeMap<String, String>,
        now: u64,
    ) -> Result<(Task, SubmitResult)> {
        let task = self.held(id, session, now)?;
        if summary.trim().is_empty() {
            return Err(
                "a summary of what changed and why is needed to land (it becomes the history)"
                    .into(),
            );
        }
        let tree = self.task_dir(id).join("tree");
        let base: BTreeMap<String, String> = serde_json::from_str(
            &fs::read_to_string(self.task_dir(id).join("base.json")).map_err(err)?,
        )
        .map_err(err)?;
        let now_files = hash_tree(&tree).map_err(err)?;
        let changes = diff(&base, &now_files);

        let reject =
            |problems: Vec<SubmitProblem>| Ok((task.clone(), SubmitResult::Rejected { problems }));
        if changes.is_empty() {
            return reject(vec![problem(
                "empty",
                None,
                "nothing in the task's tree differs from when it started",
            )]);
        }

        // Scope: a task changes one service (SPEC §8.4); notes tasks change theme notes.
        let mut problems = Vec::new();
        let mut services = BTreeSet::new();
        for c in &changes {
            let parts: Vec<&str> = c.path.split('/').collect();
            let allowed = match (task.kind, parts.as_slice()) {
                (TaskKind::Notes, ["themes", _, "notes.md"]) => true,
                (TaskKind::Notes, _) => false,
                (_, ["services", service, _, ..]) => {
                    services.insert(service.to_string());
                    true
                }
                _ => false,
            };
            if !allowed {
                let what = if task.kind == TaskKind::Notes {
                    "a notes task may only change themes/<theme>/notes.md"
                } else {
                    "a task may only change files under services/<service>/; theme files are changed through the supervisor (SPEC §9.3)"
                };
                problems.push(problem("outside", Some(&c.path), what));
            }
        }
        if services.len() > 1 {
            problems.push(problem(
                "outside",
                None,
                &format!(
                    "a task changes one service, but this touches {}",
                    services.iter().cloned().collect::<Vec<_>>().join(", ")
                ),
            ));
        }
        if let (Some(want), Some(got)) = (&task.service, services.iter().next())
            && want != got
        {
            problems.push(problem(
                "outside",
                None,
                &format!("this task is for service `{want}`, but the changes are in `{got}`"),
            ));
        }
        if let Some(s) = services.iter().next()
            && let Err(e) = check_name("service", s)
        {
            problems.push(problem("outside", None, &e));
        }

        // Lint: errors in files this task changed.
        let changed: BTreeSet<&str> = changes.iter().map(|c| c.path.as_str()).collect();
        for d in loader::load(&tree, vars).diagnostics {
            if d.severity == Severity::Error
                && d.path.as_deref().is_some_and(|p| changed.contains(p))
            {
                let at = match d.line {
                    Some(l) => format!(" (line {l})"),
                    None => String::new(),
                };
                problems.push(problem(
                    "lint",
                    d.path.as_deref(),
                    &format!("{}{at}", d.message),
                ));
            }
        }

        // Concurrency: every changed file must be as it was when the task
        // started. If one isn't, the agent is shown its current contents, and
        // that version becomes the file's base: the next submit takes the
        // tree's version as the reconciled one.
        let mut rebased = base.clone();
        for c in &changes {
            let current = hash_file(&self.dir.join(&c.path)).map_err(err)?;
            if current.as_ref() != base.get(&c.path) {
                let path = self.dir.join(&c.path);
                let text = fs::metadata(&path)
                    .ok()
                    .filter(|m| m.len() <= MAX_CONFLICT_TEXT)
                    .and_then(|_| fs::read_to_string(&path).ok());
                let message = match (&current, &text) {
                    (None, _) => "this file was deleted from the owned directory since the task started (by the user, or another task's landing). If your version should still exist, submit again as it is; otherwise delete it from the task's tree".to_string(),
                    (Some(_), Some(_)) => "this file changed in the owned directory since the task started (by the user, or another task's landing). Its current contents are included: merge them with your change in the task's tree, then submit again. The next submit takes the tree's version as the merged one".to_string(),
                    (Some(_), None) => format!("this file changed in the owned directory since the task started (by the user, or another task's landing). It's too large to include; read it at {}, merge it with your change in the task's tree, then submit again. The next submit takes the tree's version as the merged one", path.display()),
                };
                problems.push(SubmitProblem {
                    kind: "conflict".into(),
                    path: Some(c.path.clone()),
                    message,
                    current: text,
                });
                match current {
                    Some(h) => rebased.insert(c.path.clone(), h),
                    None => rebased.remove(&c.path),
                };
            }
        }
        if rebased != base {
            write_atomic(
                &self.task_dir(id).join("base.json"),
                serde_json::to_string_pretty(&rebased)
                    .map_err(err)?
                    .as_bytes(),
            )
            .map_err(err)?;
        }
        if !problems.is_empty() {
            return reject(problems);
        }

        // Land: journal first, then write.
        let seq = self.next_seq()?;
        let entry = JournalEntry {
            seq,
            task: Some(task.id.clone()),
            summary: summary.trim().to_string(),
            time: now,
            files: changes.clone(),
            undone_by: None,
            undo_of: None,
        };
        let mut files = BTreeMap::new();
        for c in &changes {
            files.insert(
                c.path.clone(),
                FileRecord {
                    existed: false,
                    after: now_files.get(&c.path).cloned(),
                },
            );
        }
        let mut afters = BTreeMap::new();
        for c in &changes {
            if c.change != ChangeKind::Deleted {
                afters.insert(c.path.clone(), fs::read(tree.join(&c.path)).map_err(err)?);
            }
        }
        let landed = Followup::Landed {
            task: task.id.clone(),
            service: services.into_iter().next(),
            outcome: TaskOutcome::Landed {
                journal: seq,
                summary: summary.trim().to_string(),
                assumptions,
            },
        };
        self.record(seq, entry, files, &afters, vec![landed])?;
        self.finish(seq)?;
        let task = self.get(id)?;
        self.prune_journal(now);
        Ok((
            task,
            SubmitResult::Landed {
                journal: seq,
                changed: changes,
            },
        ))
    }

    fn next_seq(&self) -> Result<u64> {
        Ok(self.journal_seqs()?.last().map_or(1, |s| s + 1))
    }

    fn journal_seqs(&self) -> Result<Vec<u64>> {
        let mut seqs: Vec<u64> = fs::read_dir(self.state.join("journal"))
            .map_err(err)?
            .flatten()
            .filter_map(|e| e.file_name().to_str()?.parse().ok())
            .collect();
        seqs.sort_unstable();
        Ok(seqs)
    }

    /// Writes a change down as an intent: copies of each file before and as
    /// it will be after, and what else the change does (`then`). Nothing in
    /// the owned directory changes yet; `finish` does that. If atelier stops
    /// in between, `recover` finishes it from what's recorded here.
    fn record(
        &self,
        seq: u64,
        entry: JournalEntry,
        mut files: BTreeMap<String, FileRecord>,
        afters: &BTreeMap<String, Vec<u8>>,
        then: Vec<Followup>,
    ) -> Result<()> {
        let dir = self.state.join("journal").join(seq.to_string());
        for (path, rec) in files.iter_mut() {
            let src = self.dir.join(path);
            if src.is_file() {
                rec.existed = true;
                let dst = dir.join("before").join(path);
                fs::create_dir_all(dst.parent().expect("has parent")).map_err(err)?;
                fs::copy(&src, &dst).map_err(err)?;
            }
        }
        for (path, bytes) in afters {
            let dst = dir.join("after").join(path);
            fs::create_dir_all(dst.parent().expect("has parent")).map_err(err)?;
            write_atomic(&dst, bytes).map_err(err)?;
        }
        fs::create_dir_all(&dir).map_err(err)?;
        self.write_record(
            seq,
            &JournalRecord {
                entry,
                files,
                complete: false,
                then,
            },
        )?;
        crash_point("journal-intent");
        Ok(())
    }

    fn write_record(&self, seq: u64, record: &JournalRecord) -> Result<()> {
        let dir = self.state.join("journal").join(seq.to_string());
        write_atomic(
            &dir.join("entry.json"),
            serde_json::to_string_pretty(record)
                .map_err(err)?
                .as_bytes(),
        )
        .map_err(err)
    }

    /// Makes a recorded change: writes each file as recorded (or removes it),
    /// then does what follows (a task landed, an entry undone, a proposal
    /// accepted), then marks the entry complete. Every step can be repeated,
    /// so finishing an entry that was interrupted partway is safe.
    fn finish(&self, seq: u64) -> Result<()> {
        let mut record = self.load_record(seq)?;
        if record.complete {
            return Ok(());
        }
        let after_dir = self
            .state
            .join("journal")
            .join(seq.to_string())
            .join("after");
        for (path, rec) in &record.files {
            let dst = self.dir.join(path);
            if rec.after.is_some() {
                let bytes = fs::read(after_dir.join(path)).map_err(err)?;
                fs::create_dir_all(dst.parent().expect("has parent")).map_err(err)?;
                write_atomic(&dst, &bytes).map_err(err)?;
            } else {
                match fs::remove_file(&dst) {
                    Ok(()) => {}
                    Err(e) if e.kind() == io::ErrorKind::NotFound => {}
                    Err(e) => return Err(err(e)),
                }
            }
        }
        crash_point("journal-files");
        for then in &record.then {
            match then {
                Followup::Landed {
                    task,
                    service,
                    outcome,
                } => {
                    let mut t = self.get(task)?;
                    t.state = TaskState::Landed;
                    t.lease = None;
                    t.service = t.service.clone().or(service.clone());
                    t.outcome = Some(outcome.clone());
                    t.updated = record.entry.time;
                    self.save(&t)?;
                }
                Followup::Undid { seq: undone } => {
                    let mut target = self.load_record(*undone)?;
                    if target.entry.undone_by.is_none() {
                        target.entry.undone_by = Some(seq);
                        self.write_record(*undone, &target)?;
                    }
                }
                Followup::Accepted { proposal } => self.accepted(proposal, seq)?,
            }
        }
        record.complete = true;
        self.write_record(seq, &record)
    }

    /// Finishes changes that were written down but not completed (atelier
    /// stopped partway through), oldest first. Returns their entries, so the
    /// daemon can run the hooks they missed.
    pub fn recover(&self) -> Result<Vec<JournalEntry>> {
        let mut recovered = Vec::new();
        for seq in self.journal_seqs()? {
            if !self.load_record(seq)?.complete {
                self.finish(seq)?;
                recovered.push(self.load_record(seq)?.entry);
            }
        }
        Ok(recovered)
    }

    fn load_record(&self, seq: u64) -> Result<JournalRecord> {
        let text = fs::read_to_string(
            self.state
                .join("journal")
                .join(seq.to_string())
                .join("entry.json"),
        )
        .map_err(|_| format!("no journal entry {seq}"))?;
        serde_json::from_str(&text).map_err(err)
    }

    /// Journal entries, newest first.
    pub fn journal(&self) -> Result<Vec<JournalEntry>> {
        let mut out = Vec::new();
        for seq in self.journal_seqs()?.into_iter().rev() {
            out.push(self.load_record(seq)?.entry);
        }
        Ok(out)
    }

    /// Undoes a landing (by default the latest one not yet undone), if none of
    /// its files have changed since. The undo is itself a journal entry.
    pub fn undo(&self, seq: Option<u64>, now: u64) -> Result<JournalEntry> {
        let seq = match seq {
            Some(s) => s,
            None => {
                let mut found = None;
                for s in self.journal_seqs()?.into_iter().rev() {
                    let r = self.load_record(s)?;
                    if r.entry.undone_by.is_none() && r.entry.undo_of.is_none() {
                        found = Some(s);
                        break;
                    }
                }
                found.ok_or("there's nothing to undo")?
            }
        };
        let target = self.load_record(seq)?;
        if let Some(by) = target.entry.undone_by {
            return Err(format!(
                "journal entry {seq} was already undone by entry {by}"
            ));
        }
        // Refuse if anything changed since (SPEC §8.5).
        let mut changed_since = Vec::new();
        for (path, rec) in &target.files {
            if hash_file(&self.dir.join(path)).map_err(err)? != rec.after {
                changed_since.push(path.clone());
            }
        }
        if !changed_since.is_empty() {
            return Err(format!(
                "can't undo entry {seq}: these files have changed since it landed, and undoing would overwrite that: {}",
                changed_since.join(", ")
            ));
        }

        let before_dir = self
            .state
            .join("journal")
            .join(seq.to_string())
            .join("before");
        let undo_seq = self.next_seq()?;
        let mut files = BTreeMap::new();
        let mut changes = Vec::new();
        for (path, rec) in &target.files {
            let after = if rec.existed {
                hash_file(&before_dir.join(path)).map_err(err)?
            } else {
                None
            };
            let change = match (rec.after.is_some(), rec.existed) {
                (true, true) | (false, false) => ChangeKind::Modified,
                (true, false) => ChangeKind::Deleted,
                (false, true) => ChangeKind::Added,
            };
            changes.push(FileChange {
                path: path.clone(),
                change,
            });
            files.insert(
                path.clone(),
                FileRecord {
                    existed: false,
                    after,
                },
            );
        }
        let entry = JournalEntry {
            seq: undo_seq,
            task: target.entry.task.clone(),
            summary: format!("Undo: {}", target.entry.summary),
            time: now,
            files: changes,
            undone_by: None,
            undo_of: Some(seq),
        };
        let mut afters = BTreeMap::new();
        for (path, rec) in &target.files {
            if rec.existed {
                afters.insert(path.clone(), fs::read(before_dir.join(path)).map_err(err)?);
            }
        }
        self.record(
            undo_seq,
            entry.clone(),
            files,
            &afters,
            vec![Followup::Undid { seq }],
        )?;
        self.finish(undo_seq)?;
        self.prune_journal(now);
        Ok(entry)
    }

    /// Keeps the newest JOURNAL_KEEP entries, and anything younger than
    /// JOURNAL_MAX_AGE_MS.
    fn prune_journal(&self, now: u64) {
        let Ok(seqs) = self.journal_seqs() else {
            return;
        };
        let excess = seqs.len().saturating_sub(JOURNAL_KEEP);
        for seq in seqs.into_iter().take(excess) {
            if self
                .load_record(seq)
                .is_ok_and(|r| r.complete && now.saturating_sub(r.entry.time) > JOURNAL_MAX_AGE_MS)
            {
                let _ = fs::remove_dir_all(self.state.join("journal").join(seq.to_string()));
            }
        }
    }
}

fn problem(kind: &str, path: Option<&str>, message: &str) -> SubmitProblem {
    SubmitProblem {
        kind: kind.into(),
        path: path.map(str::to_string),
        message: message.into(),
        current: None,
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

fn check_name(what: &str, name: &str) -> Result<()> {
    if name.is_empty()
        || name.starts_with('.')
        || !name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err(format!(
            "{what} name `{name}` must be letters, digits, - and _"
        ));
    }
    Ok(())
}

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

fn new_id(now: u64) -> String {
    // Readable and sortable: the creation time, plus a few bits to tell apart
    // tasks made in the same millisecond.
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.subsec_nanos());
    let salt = Sha256::digest(format!("{now}{nanos}{}", std::process::id()));
    format!("t{now:x}-{:02x}{:02x}", salt[0], salt[1])
}

/// Files under `dir`, relative paths → SHA-256, skipping dotfiles and
/// dot-directories (a .git in the owned directory isn't atelier's).
fn hash_tree(dir: &Path) -> io::Result<BTreeMap<String, String>> {
    let mut out = BTreeMap::new();
    walk(dir, dir, &mut |rel, path| {
        out.insert(rel, hash_bytes(&fs::read(path)?));
        Ok(())
    })?;
    Ok(out)
}

/// Copies `src` to `dst` (skipping dotfiles), returning the copy's hashes.
fn copy_tree(src: &Path, dst: &Path) -> io::Result<BTreeMap<String, String>> {
    let mut out = BTreeMap::new();
    walk(src, src, &mut |rel, path| {
        let bytes = fs::read(path)?;
        let to = dst.join(&rel);
        fs::create_dir_all(to.parent().expect("has parent"))?;
        fs::write(&to, &bytes)?;
        out.insert(rel, hash_bytes(&bytes));
        Ok(())
    })?;
    fs::create_dir_all(dst)?;
    Ok(out)
}

fn walk(
    root: &Path,
    dir: &Path,
    f: &mut dyn FnMut(String, &Path) -> io::Result<()>,
) -> io::Result<()> {
    let mut entries: Vec<_> = fs::read_dir(dir)?.flatten().collect();
    entries.sort_by_key(|e| e.file_name());
    for e in entries {
        let name = e.file_name();
        if name.to_string_lossy().starts_with('.') {
            continue;
        }
        let path = e.path();
        let ty = e.file_type()?;
        if ty.is_dir() {
            walk(root, &path, f)?;
        } else if ty.is_file() {
            let rel = path
                .strip_prefix(root)
                .expect("under root")
                .to_string_lossy()
                .replace('\\', "/");
            f(rel, &path)?;
        }
    }
    Ok(())
}

fn diff(base: &BTreeMap<String, String>, now: &BTreeMap<String, String>) -> Vec<FileChange> {
    let mut out = Vec::new();
    for (path, hash) in now {
        match base.get(path) {
            None => out.push(FileChange {
                path: path.clone(),
                change: ChangeKind::Added,
            }),
            Some(h) if h != hash => out.push(FileChange {
                path: path.clone(),
                change: ChangeKind::Modified,
            }),
            _ => {}
        }
    }
    for path in base.keys() {
        if !now.contains_key(path) {
            out.push(FileChange {
                path: path.clone(),
                change: ChangeKind::Deleted,
            });
        }
    }
    out.sort_by(|a, b| a.path.cmp(&b.path));
    out
}

fn hash_bytes(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

fn hash_file(path: &Path) -> io::Result<Option<String>> {
    match fs::read(path) {
        Ok(b) => Ok(Some(hash_bytes(&b))),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e),
    }
}

fn write_atomic(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let tmp = path.with_file_name(format!(
        ".{}.atelier-tmp",
        path.file_name()
            .map(|n| n.to_string_lossy())
            .unwrap_or_default()
    ));
    fs::write(&tmp, bytes)?;
    fs::rename(&tmp, path)
}

#[cfg(test)]
pub(super) mod tests {
    use super::*;
    use atelier_proto::TaskBrief;

    pub(super) struct Env {
        _tmp: tempfile::TempDir,
        pub(super) dir: PathBuf,
        pub(super) store: Store,
    }

    pub(super) fn env() -> Env {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("owned");
        let state = tmp.path().join("state");
        put(&dir, "atelier.toml", "theme = \"t\"\n");
        put(&dir, "themes/t/THEME.md", "# t\n");
        put(
            &dir,
            "services/site/t/a.user.css",
            "@-moz-document domain(\"a.example\") { p { color: red; } }\n",
        );
        put(&dir, ".git/HEAD", "ref: refs/heads/main\n");
        let store = Store::new(&dir, &state).unwrap();
        Env {
            _tmp: tmp,
            dir,
            store,
        }
    }

    pub(super) fn put(root: &Path, path: &str, text: &str) {
        let p = root.join(path);
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, text).unwrap();
    }

    pub(super) fn create(e: &Env, service: Option<&str>) -> Task {
        e.store
            .create(
                TaskCreateParams {
                    kind: TaskKind::Revise,
                    service: service.map(str::to_string),
                    brief: TaskBrief {
                        description: "make it blue".into(),
                        origin: None,
                        note: None,
                        container: None,
                        attachments: Vec::new(),
                    },
                    uploads: Vec::new(),
                },
                Some("t".into()),
                1000,
            )
            .unwrap()
    }

    pub(super) fn tree(task: &Task) -> PathBuf {
        PathBuf::from(task.tree.as_ref().unwrap())
    }

    pub(super) fn submit(e: &Env, id: &str) -> SubmitResult {
        e.store
            .submit(
                id,
                "s1",
                "Make paragraphs blue",
                vec![],
                &BTreeMap::new(),
                2000,
            )
            .unwrap()
            .1
    }

    #[test]
    fn claim_copies_the_owned_directory_without_dotfiles() {
        let e = env();
        create(&e, Some("site"));
        let t = e.store.claim(None, "s1", 1000).unwrap().unwrap();
        assert_eq!(t.state, TaskState::Claimed);
        assert!(tree(&t).join("services/site/t/a.user.css").exists());
        assert!(!tree(&t).join(".git").exists());
        // The same session can claim it again; another can't.
        assert!(e.store.claim(Some(&t.id), "s1", 1001).is_ok());
        assert!(
            e.store
                .claim(Some(&t.id), "s2", 1001)
                .unwrap_err()
                .contains("claimed by another")
        );
    }

    #[test]
    fn lands_changes_and_undoes_them() {
        let e = env();
        create(&e, Some("site"));
        let t = e.store.claim(None, "s1", 1000).unwrap().unwrap();
        put(
            &tree(&t),
            "services/site/t/a.user.css",
            "@-moz-document domain(\"a.example\") { p { color: blue; } }\n",
        );
        put(
            &tree(&t),
            "services/site/t/b.user.css",
            "@-moz-document domain(\"a.example\") { b { color: blue; } }\n",
        );
        match submit(&e, &t.id) {
            SubmitResult::Landed { journal, changed } => {
                assert_eq!(journal, 1);
                assert_eq!(
                    changed
                        .iter()
                        .map(|c| (c.path.as_str(), c.change))
                        .collect::<Vec<_>>(),
                    [
                        ("services/site/t/a.user.css", ChangeKind::Modified),
                        ("services/site/t/b.user.css", ChangeKind::Added)
                    ]
                );
            }
            other => panic!("{other:?}"),
        }
        assert!(
            fs::read_to_string(e.dir.join("services/site/t/a.user.css"))
                .unwrap()
                .contains("blue")
        );
        assert_eq!(e.store.get(&t.id).unwrap().state, TaskState::Landed);

        let undo = e.store.undo(None, 3000).unwrap();
        assert_eq!(undo.undo_of, Some(1));
        assert!(
            fs::read_to_string(e.dir.join("services/site/t/a.user.css"))
                .unwrap()
                .contains("red")
        );
        assert!(!e.dir.join("services/site/t/b.user.css").exists());
        assert_eq!(e.store.journal().unwrap()[1].undone_by, Some(2));
        // The undo can itself be undone.
        e.store.undo(Some(2), 4000).unwrap();
        assert!(
            fs::read_to_string(e.dir.join("services/site/t/a.user.css"))
                .unwrap()
                .contains("blue")
        );
    }

    #[test]
    fn undo_refuses_when_files_changed_since() {
        let e = env();
        create(&e, Some("site"));
        let t = e.store.claim(None, "s1", 1000).unwrap().unwrap();
        put(
            &tree(&t),
            "services/site/t/a.user.css",
            "@-moz-document domain(\"a.example\") { p { color: blue; } }\n",
        );
        submit(&e, &t.id);
        put(&e.dir, "services/site/t/a.user.css", "hand edit\n");
        assert!(
            e.store
                .undo(None, 3000)
                .unwrap_err()
                .contains("changed since")
        );
    }

    #[test]
    fn conflicts_send_back_the_current_file() {
        let e = env();
        create(&e, Some("site"));
        let t = e.store.claim(None, "s1", 1000).unwrap().unwrap();
        put(
            &tree(&t),
            "services/site/t/a.user.css",
            "@-moz-document domain(\"a.example\") { p { color: blue; } }\n",
        );
        put(
            &e.dir,
            "services/site/t/a.user.css",
            "@-moz-document domain(\"a.example\") { p { color: green; } }\n",
        );
        match submit(&e, &t.id) {
            SubmitResult::Rejected { problems } => {
                assert_eq!(problems[0].kind, "conflict");
                assert!(problems[0].current.as_deref().unwrap().contains("green"));
            }
            other => panic!("{other:?}"),
        }
        // Nothing was written, and the task can carry on.
        assert!(
            fs::read_to_string(e.dir.join("services/site/t/a.user.css"))
                .unwrap()
                .contains("green")
        );
        assert_eq!(e.store.get(&t.id).unwrap().state, TaskState::Claimed);

        // Having seen the current version, the agent merges, and lands.
        put(
            &tree(&t),
            "services/site/t/a.user.css",
            "@-moz-document domain(\"a.example\") { p { color: teal; } }\n",
        );
        assert!(matches!(submit(&e, &t.id), SubmitResult::Landed { .. }));
    }

    #[test]
    fn rejects_changes_outside_the_service_and_lint_errors() {
        let e = env();
        create(&e, Some("site"));
        let t = e.store.claim(None, "s1", 1000).unwrap().unwrap();
        put(&tree(&t), "themes/t/THEME.md", "# changed\n");
        put(&tree(&t), "services/other/t/x.user.css", "p {}\n");
        put(
            &tree(&t),
            "services/site/t/a.user.css",
            "@-moz-document domain(\"a.example\") { p { background: url(https://evil.example/x); } }\n",
        );
        match submit(&e, &t.id) {
            SubmitResult::Rejected { problems } => {
                let kinds: Vec<_> = problems.iter().map(|p| p.kind.as_str()).collect();
                assert!(kinds.contains(&"outside"), "{problems:?}");
                assert!(kinds.contains(&"lint"), "{problems:?}");
                assert!(
                    problems
                        .iter()
                        .any(|p| p.message.contains("this task is for service `site`")
                            || p.message.contains("touches"))
                );
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn create_tasks_pick_their_service_on_landing() {
        let e = env();
        create(&e, None);
        let t = e.store.claim(None, "s1", 1000).unwrap().unwrap();
        put(
            &tree(&t),
            "services/newsite/t/a.user.css",
            "@-moz-document domain(\"n.example\") { p { color: blue; } }\n",
        );
        assert!(matches!(submit(&e, &t.id), SubmitResult::Landed { .. }));
        assert_eq!(
            e.store.get(&t.id).unwrap().service.as_deref(),
            Some("newsite")
        );
    }

    #[test]
    fn released_tasks_keep_their_tree_and_handoff() {
        let e = env();
        create(&e, Some("site"));
        let t = e.store.claim(None, "s1", 1000).unwrap().unwrap();
        put(
            &tree(&t),
            "services/site/t/a.user.css",
            "work in progress\n",
        );
        let changes = e.store.changes(&t.id).unwrap();
        assert_eq!(changes.len(), 1);
        assert_eq!(changes[0].change, ChangeKind::Modified);
        let r = e
            .store
            .release(&t.id, "s1", "halfway: header done", 2000)
            .unwrap();
        assert_eq!(r.state, TaskState::Queued);
        let t2 = e.store.claim(None, "s2", 3000).unwrap().unwrap();
        assert_eq!(t2.handoff.as_deref(), Some("halfway: header done"));
        assert_eq!(e.store.changes(&t2.id).unwrap(), changes);
    }

    #[test]
    fn expired_leases_return_tasks_to_the_queue_with_their_tree() {
        let e = env();
        create(&e, Some("site"));
        let t = e.store.claim(None, "s1", 1000).unwrap().unwrap();
        put(
            &tree(&t),
            "services/site/t/a.user.css",
            "work in progress\n",
        );
        let later = 1000 + LEASE_MS + 1;
        assert_eq!(
            e.store.list(Some(TaskState::Queued), later).unwrap().len(),
            1
        );
        let t2 = e.store.claim(None, "s2", later).unwrap().unwrap();
        assert_eq!(t2.id, t.id);
        assert_eq!(
            fs::read_to_string(tree(&t2).join("services/site/t/a.user.css")).unwrap(),
            "work in progress\n"
        );
    }

    #[test]
    fn decline_and_abandon() {
        let e = env();
        let t = create(&e, Some("site"));
        e.store.claim(None, "s1", 1000).unwrap();
        let t = e
            .store
            .decline(&t.id, "s1", "the site is a canvas", 1500)
            .unwrap();
        assert_eq!(t.state, TaskState::Declined);
        assert!(
            e.store
                .claim(Some(&t.id), "s1", 1600)
                .unwrap_err()
                .contains("declined")
        );
        let t2 = create(&e, Some("site"));
        assert_eq!(
            e.store
                .abandon(&t2.id, "changed my mind", 1700)
                .unwrap()
                .state,
            TaskState::Abandoned
        );
    }
}
