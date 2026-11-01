//! Calls: the decisions agents faced, posted in batches (SPEC §9.5).
//!
//! A batch lives with its task, in `tasks/<task>/calls/<n>/`: `batch.json`
//! and the attachments copied in when it was posted. Its id is
//! `<task>-q<n>`. A `review` or `block` batch parks the task (`Waiting`)
//! until it's answered; then the task goes back to the queue with its tree,
//! and whoever claims it sees the answers. Answering `record` batches for a
//! task that has landed queues one `revise` carrying the calls the user
//! changed (or adds them to a `revise` for the service that nobody has
//! started yet).

use super::{Result, Store, err, write_atomic};
use atelier_proto::{
    Addressee, Answer, Batch, BatchState, BlobChunk, CallAnswerParams, CallPostParams, CallStats,
    Task, TaskBrief, TaskCreateParams, TaskKind, TaskState, Wait,
};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

/// Attachments are sent to the extension in chunks this size at most.
const CHUNK: u64 = 512 * 1024;
const MAX_ATTACHMENT: u64 = 16 * 1024 * 1024;

impl Store {
    fn batch_dir(&self, task: &str, n: u32) -> PathBuf {
        self.task_dir(task).join("calls").join(n.to_string())
    }

    /// The task and number in a batch id.
    fn parse_batch_id(id: &str) -> Result<(String, u32)> {
        id.rsplit_once("-q")
            .and_then(|(task, n)| Some((task.to_string(), n.parse().ok()?)))
            .filter(|(task, _)| !task.is_empty() && !task.contains(['/', '.']))
            .ok_or_else(|| format!("no batch `{id}`"))
    }

    fn save_batch(&self, batch: &Batch) -> Result<()> {
        let (task, n) = Self::parse_batch_id(&batch.id)?;
        let dir = self.batch_dir(&task, n);
        fs::create_dir_all(&dir).map_err(err)?;
        write_atomic(
            &dir.join("batch.json"),
            serde_json::to_string_pretty(batch).map_err(err)?.as_bytes(),
        )
        .map_err(err)
    }

    pub fn batch(&self, id: &str) -> Result<Batch> {
        let (task, n) = Self::parse_batch_id(id)?;
        let text = fs::read_to_string(self.batch_dir(&task, n).join("batch.json"))
            .map_err(|_| format!("no batch `{id}`"))?;
        serde_json::from_str(&text).map_err(err)
    }

    /// Posts a batch of calls for a task this session holds. Attachments
    /// must be files in the task's directory (its tree, or scratch space
    /// next to it); they're copied in, so later edits don't change them.
    pub fn post(&self, p: CallPostParams, now: u64) -> Result<(Task, Batch)> {
        let mut task = self.held(&p.task, &p.session, now)?;
        if p.calls.is_empty() {
            return Err("a batch needs at least one call".into());
        }
        if p.calls.iter().any(|c| c.question.trim().is_empty()) {
            return Err("every call needs a question".into());
        }
        let n = match &p.replaces {
            Some(old) => {
                let (of, n) = Self::parse_batch_id(old)?;
                let b = self.batch(old)?;
                if of != task.id {
                    return Err(format!("batch {old} is another task's"));
                }
                if b.state != BatchState::Open {
                    return Err(format!(
                        "batch {old} has been answered already, so it can't be replaced; post a new one"
                    ));
                }
                // Its attachments go with it.
                let dir = self.batch_dir(&task.id, n);
                for e in fs::read_dir(&dir).map_err(err)?.flatten() {
                    if e.file_name() != "batch.json" {
                        fs::remove_file(e.path()).map_err(err)?;
                    }
                }
                n
            }
            None => self.next_batch(&task.id),
        };
        let dir = self.batch_dir(&task.id, n);
        let task_dir = self.task_dir(&task.id).canonicalize().map_err(err)?;
        let mut calls = p.calls;
        for (i, call) in calls.iter_mut().enumerate() {
            call.answer = None;
            call.wait = Some(call.wait.unwrap_or(p.wait));
            if call.variant.is_some() {
                resolve_variant(&self.task_dir(&task.id).join("tree"), call)?;
            }
            normalise_choice(call);
            let mut names = Vec::new();
            for path in &call.attachments {
                let src = Path::new(path)
                    .canonicalize()
                    .map_err(|e| format!("attachment {path}: {e}"))?;
                if !src.starts_with(&task_dir) {
                    return Err(format!(
                        "attachment {path} isn't in the task's directory ({}); save screenshots there (screenshot's attach option does)",
                        task_dir.display()
                    ));
                }
                let size = fs::metadata(&src).map_err(err)?.len();
                if size > MAX_ATTACHMENT {
                    return Err(format!("attachment {path} is too large ({size} bytes)"));
                }
                let base = src
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or("attachment");
                let name = format!("{}-{base}", i + 1);
                fs::create_dir_all(&dir).map_err(err)?;
                fs::copy(&src, dir.join(&name)).map_err(err)?;
                names.push(name);
            }
            call.attachments = names;
        }
        let batch = Batch {
            id: format!("{}-q{n}", task.id),
            task: task.id.clone(),
            to: Addressee::User,
            wait: calls
                .iter()
                .filter_map(|c| c.wait)
                .max()
                .unwrap_or_default(),
            summary: p.summary.filter(|s| !s.trim().is_empty()),
            calls,
            state: BatchState::Open,
            created: now,
            answered: None,
            origin: task.brief.origin.clone(),
            service: task.service.clone(),
        };
        self.save_batch(&batch)?;
        if batch.wait != Wait::Record {
            match p.hold_ms {
                // Held: still the session's, until the answers come or the hold ends.
                Some(hold) if hold > 0 => {
                    task.state = TaskState::Claimed;
                    task.lease = Some(atelier_proto::Lease {
                        session: p.session.clone(),
                        expires: now + hold.min(super::LEASE_MS),
                    });
                }
                _ => {
                    task.state = TaskState::Waiting;
                    task.lease = None;
                }
            }
            task.updated = now;
            self.save(&task)?;
        } else if task.state == TaskState::Queued {
            // `held` accepts a task whose lease lapsed unclaimed; posting is
            // work on it, so it's claimed again.
            task.state = TaskState::Claimed;
            self.save(&task)?;
        }
        Ok((task, batch))
    }

    /// Records a landing's assumptions as a batch of calls, so the user can
    /// revisit them like any other (SPEC §9.5).
    pub fn record_assumptions(
        &self,
        task: &Task,
        assumptions: &[String],
        now: u64,
    ) -> Result<Option<Batch>> {
        let calls: Vec<_> = assumptions
            .iter()
            .filter(|a| !a.trim().is_empty())
            .map(|a| atelier_proto::Call {
                question: a.trim().to_string(),
                context: None,
                options: Vec::new(),
                choice: None,
                scope: atelier_proto::CallScope::Site,
                attachments: Vec::new(),
                wait: Some(Wait::Record),
                variant: None,
                answer: None,
            })
            .collect();
        if calls.is_empty() {
            return Ok(None);
        }
        let n = self.next_batch(&task.id);
        let batch = Batch {
            id: format!("{}-q{n}", task.id),
            task: task.id.clone(),
            to: Addressee::User,
            wait: Wait::Record,
            summary: Some("Calls made while doing this, recorded when it landed.".into()),
            calls,
            state: BatchState::Open,
            created: now,
            answered: None,
            origin: task.brief.origin.clone(),
            service: task.service.clone(),
        };
        self.save_batch(&batch)?;
        Ok(Some(batch))
    }

    fn next_batch(&self, task: &str) -> u32 {
        fs::read_dir(self.task_dir(task).join("calls"))
            .map(|d| {
                d.flatten()
                    .filter_map(|e| e.file_name().to_str()?.parse::<u32>().ok())
                    .max()
                    .unwrap_or(0)
            })
            .unwrap_or(0)
            + 1
    }

    /// Parks a task this session holds that has a batch waiting for answers.
    pub fn park(&self, id: &str, session: &str, now: u64) -> Result<Task> {
        let mut task = self.held(id, session, now)?;
        if !self.awaits_answers(id)? {
            return Err(format!("task {id} has no calls waiting for answers"));
        }
        task.state = TaskState::Waiting;
        task.lease = None;
        task.updated = now;
        self.save(&task)?;
        Ok(task)
    }

    /// Whether a task has a batch still waiting for answers before it can land.
    pub(super) fn awaits_answers(&self, task: &str) -> Result<bool> {
        Ok(self
            .batches(true, Some(task))?
            .iter()
            .any(|b| b.wait != Wait::Record))
    }

    /// Batches, newest first: all, or only those still waiting for an
    /// answer (leaving out those of tasks that have since finished).
    pub fn batches(&self, open_only: bool, task: Option<&str>) -> Result<Vec<Batch>> {
        let mut out = Vec::new();
        let tasks = match task {
            Some(t) => vec![t.to_string()],
            None => fs::read_dir(self.state.join("tasks"))
                .map_err(err)?
                .flatten()
                .filter_map(|e| e.file_name().to_str().map(str::to_string))
                .collect(),
        };
        for t in tasks {
            let Ok(dirs) = fs::read_dir(self.task_dir(&t).join("calls")) else {
                continue;
            };
            let finished = open_only
                && self
                    .get(&t)
                    .is_ok_and(|t| matches!(t.state, TaskState::Declined | TaskState::Abandoned));
            for d in dirs.flatten() {
                let Ok(text) = fs::read_to_string(d.path().join("batch.json")) else {
                    continue;
                };
                let Ok(batch) = serde_json::from_str::<Batch>(&text) else {
                    continue;
                };
                if open_only && (batch.state != BatchState::Open || finished) {
                    continue;
                }
                out.push(batch);
            }
        }
        out.sort_by(|a, b| (b.created, &b.id).cmp(&(a.created, &a.id)));
        Ok(out)
    }

    /// Answers a batch. Returns it, the task if this sent it back to the
    /// queue, and the `revise` task (new, or one already queued that the
    /// changes joined) for record calls the user changed after the work
    /// landed.
    #[cfg(test)]
    pub fn answer(
        &self,
        p: CallAnswerParams,
        theme: Option<String>,
        now: u64,
    ) -> Result<(Batch, Option<Task>, Vec<Task>)> {
        let (mut batches, requeued, revisions) = self.answer_all(vec![p], theme, now)?;
        Ok((batches.remove(0), requeued.into_iter().next(), revisions))
    }

    /// Answers several batches at once, as the inbox does for all of a
    /// task's: what the user changed then goes to one `revise` per task,
    /// not one per call, so the agent that takes it sees the changes
    /// together. Returns the batches, the tasks this sent back to the queue,
    /// and the `revise` tasks queued or joined.
    pub fn answer_all(
        &self,
        ps: Vec<CallAnswerParams>,
        theme: Option<String>,
        now: u64,
    ) -> Result<(Vec<Batch>, Vec<Task>, Vec<Task>)> {
        if ps.is_empty() {
            return Err("no batches to answer".into());
        }
        // Everything is checked before anything is written.
        let mut batches = Vec::new();
        for p in &ps {
            let batch = self.batch(&p.batch)?;
            if batch.state != BatchState::Open {
                return Err(format!("batch {} has already been answered", batch.id));
            }
            if batches.iter().any(|(b, _): &(Batch, _)| b.id == batch.id) {
                return Err(format!("batch {} is answered twice", batch.id));
            }
            if p.answers.len() > batch.calls.len() {
                return Err(format!(
                    "batch {} has {} calls, but {} answers were given",
                    batch.id,
                    batch.calls.len(),
                    p.answers.len()
                ));
            }
            batches.push((batch, &p.answers));
        }

        let mut out = Vec::new();
        // Changed record calls of landed tasks, by task, in order.
        let mut changed: Vec<(Task, Vec<Revisit>)> = Vec::new();
        for (mut batch, answers) in batches {
            for (i, call) in batch.calls.iter_mut().enumerate() {
                let input = answers.get(i).cloned().unwrap_or_default();
                let note = input.note.filter(|n| !n.trim().is_empty());
                let choice = input.choice.filter(|c| !c.trim().is_empty());
                let kept = note.is_none()
                    && choice
                        .as_ref()
                        .is_none_or(|c| Some(c) == call.choice.as_ref());
                call.answer = Some(Answer {
                    choice: choice.or_else(|| call.choice.clone()),
                    note,
                    kept,
                    applied: false,
                    time: now,
                });
            }
            batch.state = BatchState::Answered;
            batch.answered = Some(now);

            let task = self.get(&batch.task)?;
            // A variant answered with another option is written in now: into the
            // tree while the work is unlanded, into the owned directory (through
            // the journal) once it has landed.
            for call in batch.calls.iter_mut() {
                let (Some(v), Some(a)) = (&call.variant, call.answer.as_mut()) else {
                    continue;
                };
                let Some(chosen) = a.choice.clone().filter(|c| Some(c) != call.choice.as_ref())
                else {
                    continue;
                };
                let Some(css) = v.css.get(&chosen) else {
                    continue;
                };
                if task.state == TaskState::Landed {
                    let current = fs::read_to_string(self.dir.join(&v.file)).unwrap_or_default();
                    if let Some(text) = replace_block(&current, &v.name, css) {
                        let summary =
                            format!("{}: {chosen} for {} (the user's choice)", v.file, v.name);
                        self.land_text(
                            &v.file,
                            &text,
                            &summary,
                            Some(task.id.clone()),
                            Vec::new(),
                            now,
                        )?;
                        a.applied = true;
                    }
                } else if task.tree.is_some() {
                    let path = self.task_dir(&task.id).join("tree").join(&v.file);
                    let current = fs::read_to_string(&path).unwrap_or_default();
                    if let Some(text) = replace_block(&current, &v.name, css) {
                        write_atomic(&path, text.as_bytes()).map_err(err)?;
                        a.applied = true;
                    }
                }
            }
            self.save_batch(&batch)?;
            if task.state == TaskState::Landed {
                let items: Vec<Revisit> = batch
                    .calls
                    .iter()
                    .filter(|c| c.wait == Some(Wait::Record))
                    .filter_map(revisit)
                    .collect();
                if !items.is_empty() {
                    match changed.iter_mut().find(|(t, _)| t.id == task.id) {
                        Some((_, all)) => all.extend(items),
                        None => changed.push((task, items)),
                    }
                }
            }
            out.push(batch);
        }

        let mut requeued = Vec::new();
        for b in &out {
            if requeued.iter().any(|t: &Task| t.id == b.task) {
                continue;
            }
            let mut task = self.get(&b.task)?;
            if task.state == TaskState::Waiting
                && self
                    .batches(true, Some(&task.id))?
                    .iter()
                    .all(|b| b.wait == Wait::Record)
            {
                task.state = TaskState::Queued;
                task.updated = now;
                self.save(&task)?;
                requeued.push(task);
            }
        }
        let mut revisions = Vec::new();
        for (task, items) in changed {
            revisions.push(self.revise_from(&task, &items, theme.clone(), now)?);
        }
        Ok((out, requeued, revisions))
    }

    /// Queues a `revise` carrying the calls the user changed on a landed
    /// task. If a `revise` for the same service is already queued and
    /// nobody has started it, the changes join it instead: one task per
    /// service at a time, so two agents don't work on the same files in
    /// separate trees (SPEC §8.3).
    fn revise_from(
        &self,
        task: &Task,
        items: &[Revisit],
        theme: Option<String>,
        now: u64,
    ) -> Result<Task> {
        let list = items
            .iter()
            .enumerate()
            .map(|(i, r)| format!("{}. {}", i + 1, r.text))
            .collect::<Vec<_>>()
            .join("\n");
        let mut note = format!(
            "Looking over the calls made in an earlier task ({}), the user changed {}:\n{list}",
            task.id,
            if items.len() == 1 { "one" } else { "these" },
        );
        // What that task wrote, which may not be what it said it chose.
        let diff = self.landing_diff(&task.id)?.map(|text| {
            use base64::Engine;
            atelier_proto::Upload {
                name: format!("{}-landed.diff", task.id),
                data: base64::engine::general_purpose::STANDARD.encode(text),
            }
        });
        if let Some(d) = &diff {
            note.push_str(&format!(
                "\nWhat {} changed when it landed is attached ({}): look at what it actually wrote before changing it.",
                task.id, d.name
            ));
        }
        let pending = self
            .list(Some(TaskState::Queued), now)?
            .into_iter()
            .find(|t| {
                t.kind == TaskKind::Revise
                    && t.tree.is_none()
                    && t.service.is_some()
                    && t.service == task.service
            });
        if let Some(mut pending) = pending {
            pending.brief.note = Some(match pending.brief.note.take() {
                Some(n) => format!("{n}\n\n{note}"),
                None => note,
            });
            let service = task.service.as_deref().unwrap_or_default();
            pending.brief.description = format!("Revisit calls from earlier work on {service}");
            if let Some(d) = &diff {
                let path = self.attach(&pending.id, d)?;
                if !pending.brief.attachments.contains(&path) {
                    pending.brief.attachments.push(path);
                }
            }
            pending.updated = now;
            self.save(&pending)?;
            return Ok(pending);
        }
        let description = match items {
            [one] => format!(
                "Revisit a call from an earlier task ({}): {}",
                task.id, one.question
            ),
            _ => format!(
                "Revisit {} calls from an earlier task ({})",
                items.len(),
                task.id
            ),
        };
        self.create(
            TaskCreateParams {
                kind: TaskKind::Revise,
                service: task.service.clone(),
                brief: TaskBrief {
                    description,
                    origin: task.brief.origin.clone(),
                    note: Some(note),
                    container: task.brief.container.clone(),
                    attachments: Vec::new(),
                },
                uploads: diff.into_iter().collect(),
            },
            theme,
            now,
        )
    }

    /// How often the user kept agents' calls, for tasks on this theme. A
    /// call counts if it had something to keep: a provisional choice, or
    /// being a record of what the agent did.
    pub fn stats(&self, theme: Option<&str>) -> Result<CallStats> {
        let mut stats = CallStats::default();
        for batch in self.batches(false, None)? {
            if batch.state != BatchState::Answered {
                continue;
            }
            if theme.is_some()
                && self.get(&batch.task).ok().and_then(|t| t.theme).as_deref() != theme
            {
                continue;
            }
            for call in &batch.calls {
                if call.choice.is_none() && call.wait != Some(Wait::Record) {
                    continue;
                }
                if let Some(a) = &call.answer {
                    stats.answered += 1;
                    stats.kept += u32::from(a.kept);
                }
            }
        }
        Ok(stats)
    }

    /// A chunk of one of a batch's attachments.
    pub fn attachment(&self, batch: &str, name: &str, offset: u64, len: u64) -> Result<BlobChunk> {
        use base64::Engine;
        use std::io::{Read, Seek, SeekFrom};
        let b = self.batch(batch)?;
        if !b
            .calls
            .iter()
            .any(|c| c.attachments.iter().any(|a| a == name))
        {
            return Err(format!("batch {batch} has no attachment `{name}`"));
        }
        let (task, n) = Self::parse_batch_id(batch)?;
        let mut file = fs::File::open(self.batch_dir(&task, n).join(name)).map_err(err)?;
        let size = file.metadata().map_err(err)?.len();
        file.seek(SeekFrom::Start(offset.min(size))).map_err(err)?;
        let mut buf = Vec::new();
        file.take(len.min(CHUNK))
            .read_to_end(&mut buf)
            .map_err(err)?;
        Ok(BlobChunk {
            eof: offset + buf.len() as u64 >= size,
            data: base64::engine::general_purpose::STANDARD.encode(&buf),
        })
    }
}

/// A record call the user changed after the work landed, for a `revise`.
struct Revisit {
    question: String,
    /// The call, what the agent did, and what the user wants instead.
    text: String,
}

/// What a `revise` needs to know about an answered record call, if the
/// user changed it and an agent has something to do: a different option
/// for a variant is already written in, unless the user also said
/// something.
fn revisit(call: &atelier_proto::Call) -> Option<Revisit> {
    let a = call
        .answer
        .as_ref()
        .filter(|a| !a.kept && !(a.applied && a.note.is_none()))?;
    let mut said = Vec::new();
    if a.choice != call.choice
        && let Some(c) = &a.choice
    {
        said.push(format!(
            "they chose: {c}{}",
            if a.applied {
                " (already written in)"
            } else {
                ""
            }
        ));
    }
    if let Some(n) = &a.note {
        said.push(format!("they said: {n}"));
    }
    let made = call.choice.as_deref().unwrap_or("(no choice recorded)");
    Some(Revisit {
        question: call.question.clone(),
        text: format!(
            "{}\n   The agent went with: {made}. Looking at it afterwards, {}.",
            call.question,
            said.join("; ")
        ),
    })
}

fn markers(name: &str) -> (String, String) {
    (
        format!("/* atelier:variant {name} */"),
        format!("/* atelier:end {name} */"),
    )
}

/// The CSS between a variant's markers.
fn block(text: &str, name: &str) -> Option<String> {
    let (start, end) = markers(name);
    let s = text.find(&start)? + start.len();
    let e = s + text[s..].find(&end)?;
    Some(text[s..e].trim().to_string())
}

/// `text` with the CSS between a variant's markers replaced by `css`,
/// keeping the end marker's indentation.
pub(super) fn replace_block(text: &str, name: &str, css: &str) -> Option<String> {
    let (start, end) = markers(name);
    let s = text.find(&start)? + start.len();
    let e = s + text[s..].find(&end)?;
    // The end marker's line, from its start: kept as it is, indentation included.
    let line = text[..e].rfind('\n').map_or(0, |i| i + 1);
    let end_from = if text[line..e].trim().is_empty() {
        line
    } else {
        e
    };
    let mut css = css.trim_end().to_string();
    if end_from == e {
        css.push(' ');
    }
    Some(format!("{}\n{css}\n{}", &text[..s], &text[end_from..]))
}

/// Fills in a variant call from the tree: the style file whose markers name
/// it, and each option's CSS from variants/NAME/*.css beside that file. The
/// options are those files' names; the agent's choice, unless given, is the
/// one matching what's between the markers now.
fn resolve_variant(tree: &Path, call: &mut atelier_proto::Call) -> Result<()> {
    let v = call.variant.as_mut().expect("checked by the caller");
    let name = v.name.trim().to_string();
    if name.is_empty()
        || !name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err(format!(
            "variant `{name}`: names are letters, digits, - and _"
        ));
    }
    let (start, _) = markers(&name);
    let mut found = Vec::new();
    for service in fs::read_dir(tree.join("services"))
        .into_iter()
        .flatten()
        .flatten()
    {
        for theme in fs::read_dir(service.path()).into_iter().flatten().flatten() {
            for file in fs::read_dir(theme.path()).into_iter().flatten().flatten() {
                let path = file.path();
                if path.to_string_lossy().ends_with(".user.css")
                    && fs::read_to_string(&path).is_ok_and(|t| t.contains(&start))
                {
                    found.push(path);
                }
            }
        }
    }
    let file = match found.as_slice() {
        [one] => one.clone(),
        [] => {
            return Err(format!(
                "variant `{name}`: no style file in the tree marks it with {start} … /* atelier:end {name} */"
            ));
        }
        _ => {
            return Err(format!(
                "variant `{name}` is marked in more than one style file"
            ));
        }
    };
    let dir = file
        .parent()
        .expect("has parent")
        .join("variants")
        .join(&name);
    let mut css = BTreeMap::new();
    for f in fs::read_dir(&dir).into_iter().flatten().flatten() {
        let p = f.path();
        if p.extension().is_some_and(|e| e == "css")
            && let (Some(stem), Ok(text)) = (
                p.file_stem().and_then(|s| s.to_str()),
                fs::read_to_string(&p),
            )
        {
            css.insert(stem.to_string(), text);
        }
    }
    if css.len() < 2 {
        return Err(format!(
            "variant `{name}`: put each option's CSS (yours too) in {}/<option>.css; found {}",
            dir.display(),
            css.len()
        ));
    }
    let current = fs::read_to_string(&file)
        .ok()
        .and_then(|t| block(&t, &name))
        .unwrap_or_default();
    call.options = css.keys().cloned().collect();
    if call.choice.as_ref().is_none_or(|c| !css.contains_key(c)) {
        call.choice = css
            .iter()
            .find(|(_, c)| c.trim() == current)
            .map(|(k, _)| k.clone());
    }
    v.name = name;
    v.file = file
        .strip_prefix(tree)
        .map_err(err)?
        .to_string_lossy()
        .into_owned();
    v.css = css;
    Ok(())
}

/// A choice should be one of the options when there are options, so the
/// inbox can preselect it. Agents sometimes add their reasons to it
/// ("Recessed, as built: the site's own design survives"): keep the option,
/// and move the reasons into the context.
fn normalise_choice(call: &mut atelier_proto::Call) {
    let Some(choice) = call.choice.clone() else {
        return;
    };
    if call.options.is_empty() || call.options.contains(&choice) {
        return;
    }
    let Some(option) = call
        .options
        .iter()
        .filter(|o| choice.starts_with(o.as_str()))
        .max_by_key(|o| o.len())
        .cloned()
    else {
        return;
    };
    let reasons = choice[option.len()..]
        .trim_start_matches([':', ';', ',', '.', '-', '—', ' '])
        .trim();
    if !reasons.is_empty() {
        let why = format!("Why the agent would choose \"{option}\": {reasons}");
        call.context = Some(match call.context.take() {
            Some(c) => format!("{c}\n\n{why}"),
            None => why,
        });
    }
    call.choice = Some(option);
}

#[cfg(test)]
mod tests {
    use super::super::tests::{create, env, put, tree};
    use super::*;
    use atelier_proto::{AnswerInput, Call, CallScope};

    fn call(question: &str, choice: Option<&str>) -> Call {
        Call {
            question: question.into(),
            context: None,
            options: vec!["teal".into(), "mauve".into()],
            choice: choice.map(str::to_string),
            scope: CallScope::Site,
            attachments: Vec::new(),
            wait: None,
            variant: None,
            answer: None,
        }
    }

    #[test]
    fn one_batch_can_mix_record_and_review() {
        let e = env();
        create(&e, Some("site"));
        let t = e.store.claim(None, "s1", 1000).unwrap().unwrap();
        let mut ask = call("Cards raised or recessed?", Some("teal"));
        ask.wait = Some(Wait::Review);
        let (task, batch) = e
            .store
            .post(
                CallPostParams {
                    task: t.id,
                    session: "s1".into(),
                    wait: Wait::Record,
                    summary: None,
                    calls: vec![ask, call("Kept the pill shapes", Some("teal"))],
                    hold_ms: None,
                    replaces: None,
                },
                2000,
            )
            .unwrap();
        assert_eq!(batch.wait, Wait::Review);
        assert_eq!(batch.calls[1].wait, Some(Wait::Record));
        assert_eq!(task.state, TaskState::Waiting);
    }

    #[test]
    fn a_review_parks_the_task_until_answered() {
        let e = env();
        create(&e, Some("site"));
        let t = e.store.claim(None, "s1", 1000).unwrap().unwrap();
        put(&tree(&t), "../shot.jpg", "jpeg");
        let mut c = call("Which accent for the header?", Some("teal"));
        c.attachments = vec![tree(&t).join("../shot.jpg").display().to_string()];
        let (task, batch) = e
            .store
            .post(
                CallPostParams {
                    task: t.id.clone(),
                    session: "s1".into(),
                    wait: Wait::Review,
                    summary: Some("first pass".into()),
                    calls: vec![c, call("Hide the banner?", None)],
                    hold_ms: None,
                    replaces: None,
                },
                2000,
            )
            .unwrap();
        assert_eq!(task.state, TaskState::Waiting);
        assert_eq!(batch.calls[0].attachments, ["1-shot.jpg"]);
        // Nobody can claim it while it waits.
        assert!(e.store.claim(None, "s2", 2500).unwrap().is_none());
        assert_eq!(e.store.batches(true, None).unwrap().len(), 1);
        let chunk = e.store.attachment(&batch.id, "1-shot.jpg", 0, 100).unwrap();
        assert!(chunk.eof);

        let (answered, requeued, revisions) = e
            .store
            .answer(
                CallAnswerParams {
                    batch: batch.id.clone(),
                    answers: vec![
                        AnswerInput::default(),
                        AnswerInput {
                            choice: None,
                            note: Some("yes, it's noise".into()),
                        },
                    ],
                },
                Some("t".into()),
                3000,
            )
            .unwrap();
        assert!(answered.calls[0].answer.as_ref().unwrap().kept);
        assert_eq!(
            answered.calls[0].answer.as_ref().unwrap().choice.as_deref(),
            Some("teal")
        );
        assert!(!answered.calls[1].answer.as_ref().unwrap().kept);
        assert_eq!(requeued.unwrap().state, TaskState::Queued);
        assert!(revisions.is_empty());
        assert_eq!(
            e.store.stats(None).unwrap(),
            CallStats {
                answered: 1,
                kept: 1
            }
        );
        // The next claim resumes it.
        assert_eq!(e.store.claim(None, "s2", 4000).unwrap().unwrap().id, t.id);
    }

    #[test]
    fn changing_a_recorded_call_after_landing_queues_a_revise() {
        let e = env();
        create(&e, Some("site"));
        let t = e.store.claim(None, "s1", 1000).unwrap().unwrap();
        let (_, batch) = e
            .store
            .post(
                CallPostParams {
                    task: t.id.clone(),
                    session: "s1".into(),
                    wait: Wait::Record,
                    summary: None,
                    calls: vec![call("Header accent", Some("teal"))],
                    hold_ms: None,
                    replaces: None,
                },
                1500,
            )
            .unwrap();
        assert_eq!(e.store.get(&t.id).unwrap().state, TaskState::Claimed);
        put(
            &tree(&t),
            "services/site/t/a.user.css",
            "@-moz-document domain(\"a.example\") { p { color: teal; } }\n",
        );
        super::super::tests::submit(&e, &t.id);
        let (_, _, revisions) = e
            .store
            .answer(
                CallAnswerParams {
                    batch: batch.id,
                    answers: vec![AnswerInput {
                        choice: Some("mauve".into()),
                        note: None,
                    }],
                },
                Some("t".into()),
                3000,
            )
            .unwrap();
        assert_eq!(revisions.len(), 1);
        assert_eq!(revisions[0].kind, TaskKind::Revise);
        assert_eq!(revisions[0].service.as_deref(), Some("site"));
        assert!(
            revisions[0]
                .brief
                .note
                .as_deref()
                .unwrap()
                .contains("they chose: mauve")
        );
        // With what the earlier task wrote, attached.
        let [diff] = &revisions[0].brief.attachments[..] else {
            panic!("one attachment: {:?}", revisions[0].brief.attachments)
        };
        assert!(diff.ends_with(&format!("{}-landed.diff", t.id)));
        let text = fs::read_to_string(diff).unwrap();
        assert!(text.contains("+++ b/services/site/t/a.user.css"), "{text}");
        assert!(text.contains("p { color: teal; }"), "{text}");
    }

    #[test]
    fn an_unanswered_batch_can_be_replaced_and_an_answered_one_cant() {
        let e = env();
        create(&e, Some("site"));
        let t = e.store.claim(None, "s1", 1000).unwrap().unwrap();
        let post = |q: &str, replaces: Option<String>| {
            e.store.post(
                CallPostParams {
                    task: t.id.clone(),
                    session: "s1".into(),
                    wait: Wait::Record,
                    summary: None,
                    calls: vec![call(q, Some("teal"))],
                    hold_ms: None,
                    replaces,
                },
                2000,
            )
        };
        let (_, first) = post("Header accent (no good)", None).unwrap();
        let (_, fixed) = post("Header accent", Some(first.id.clone())).unwrap();
        assert_eq!(fixed.id, first.id);
        let all = e.store.batches(false, Some(&t.id)).unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].calls[0].question, "Header accent");

        e.store
            .answer(
                CallAnswerParams {
                    batch: first.id.clone(),
                    answers: vec![],
                },
                None,
                3000,
            )
            .unwrap();
        let late = post("Header accent, again", Some(first.id)).unwrap_err();
        assert!(late.contains("answered already"), "{late}");
    }

    #[test]
    fn a_tasks_changed_calls_go_to_one_revise_which_later_changes_join() {
        let e = env();
        create(&e, Some("site"));
        let t = e.store.claim(None, "s1", 1000).unwrap().unwrap();
        let post = |q: &str, at| {
            e.store
                .post(
                    CallPostParams {
                        task: t.id.clone(),
                        session: "s1".into(),
                        wait: Wait::Record,
                        summary: None,
                        calls: vec![call(q, Some("teal"))],
                        hold_ms: None,
                        replaces: None,
                    },
                    at,
                )
                .unwrap()
                .1
        };
        let (a, b) = (post("Header accent", 1500), post("Link accent", 1600));
        put(
            &tree(&t),
            "services/site/t/a.user.css",
            "@-moz-document domain(\"a.example\") { p { color: teal; } }\n",
        );
        super::super::tests::submit(&e, &t.id);
        let change = |batch: &Batch, to: &str| CallAnswerParams {
            batch: batch.id.clone(),
            answers: vec![AnswerInput {
                choice: Some(to.into()),
                note: None,
            }],
        };
        let (_, _, revisions) = e
            .store
            .answer_all(vec![change(&a, "mauve"), change(&b, "peach")], None, 3000)
            .unwrap();
        assert_eq!(
            revisions.len(),
            1,
            "one revise for the task, not one per call"
        );
        let note = revisions[0].brief.note.clone().unwrap();
        assert!(
            note.contains("they chose: mauve") && note.contains("they chose: peach"),
            "{note}"
        );

        // Another landed task on the same service: its changes join the
        // queued revise, since nobody has started it.
        let t2 = create(&e, Some("site"));
        let t2 = e.store.claim(Some(&t2.id), "s1", 3500).unwrap().unwrap();
        let c = e
            .store
            .post(
                CallPostParams {
                    task: t2.id.clone(),
                    session: "s1".into(),
                    wait: Wait::Record,
                    summary: None,
                    calls: vec![call("Footer rule", Some("1px"))],
                    hold_ms: None,
                    replaces: None,
                },
                3600,
            )
            .unwrap()
            .1;
        put(
            &tree(&t2),
            "services/site/t/a.user.css",
            "@-moz-document domain(\"a.example\") { p { color: navy; } }\n",
        );
        super::super::tests::submit(&e, &t2.id);
        let (_, _, joined) = e.store.answer(change(&c, "2px"), None, 4000).unwrap();
        assert_eq!(joined[0].id, revisions[0].id);
        let note = joined[0].brief.note.clone().unwrap();
        assert!(
            note.contains("mauve") && note.contains("they chose: 2px"),
            "{note}"
        );
        let queued = e.store.list(Some(TaskState::Queued), 4000).unwrap();
        assert_eq!(queued.len(), 1, "{queued:?}");
    }

    #[test]
    fn a_held_review_stays_claimed_and_parks_when_the_hold_runs_out() {
        let e = env();
        create(&e, Some("site"));
        let t = e.store.claim(None, "s1", 1000).unwrap().unwrap();
        let mut c = call("Raised or recessed?", Some("teal"));
        c.wait = Some(Wait::Review);
        let (task, batch) = e
            .store
            .post(
                CallPostParams {
                    task: t.id.clone(),
                    session: "s1".into(),
                    wait: Wait::Record,
                    summary: None,
                    calls: vec![c],
                    hold_ms: Some(60_000),
                    replaces: None,
                },
                2000,
            )
            .unwrap();
        assert_eq!(task.state, TaskState::Claimed);
        // Answered within the hold: the session still has it, nothing requeued.
        let (_, requeued, _) = e
            .store
            .answer(
                CallAnswerParams {
                    batch: batch.id,
                    answers: vec![],
                },
                None,
                3000,
            )
            .unwrap();
        assert!(requeued.is_none());
        assert_eq!(e.store.get(&t.id).unwrap().state, TaskState::Claimed);

        // Another held review, unanswered past the hold: it waits, not queued.
        let mut c = call("Again?", None);
        c.wait = Some(Wait::Review);
        e.store
            .post(
                CallPostParams {
                    task: t.id.clone(),
                    session: "s1".into(),
                    wait: Wait::Record,
                    summary: None,
                    calls: vec![c],
                    hold_ms: Some(1000),
                    replaces: None,
                },
                4000,
            )
            .unwrap();
        let later = e.store.list(None, 6000).unwrap();
        assert_eq!(later[0].state, TaskState::Waiting);
    }

    #[test]
    fn replacing_a_block_keeps_the_markers_and_indentation() {
        let text = "a {\n  /* atelier:variant cards */\n  p { color: red; }\n  /* atelier:end cards */\n}\n";
        assert_eq!(
            replace_block(text, "cards", "p { color: blue; }\n").unwrap(),
            "a {\n  /* atelier:variant cards */\np { color: blue; }\n  /* atelier:end cards */\n}\n"
        );
        assert_eq!(block(text, "cards").as_deref(), Some("p { color: red; }"));
        assert!(replace_block(text, "other", "x").is_none());
    }

    fn variant_tree(tree: &Path) {
        put(
            tree,
            "services/site/t/a.user.css",
            "@-moz-document domain(\"a.example\") {\n  /* atelier:variant cards */\n  .card { background: #181825; }\n  /* atelier:end cards */\n}\n",
        );
        put(
            tree,
            "services/site/t/variants/cards/recessed.css",
            ".card { background: #181825; }\n",
        );
        put(
            tree,
            "services/site/t/variants/cards/raised.css",
            ".card { background: #313244; }\n",
        );
    }

    fn variant_call(wait: Wait) -> atelier_proto::Call {
        let mut c = call("Cards recessed or raised?", None);
        c.options = Vec::new();
        c.wait = Some(wait);
        c.variant = Some(atelier_proto::Variant {
            name: "cards".into(),
            file: String::new(),
            css: Default::default(),
        });
        c
    }

    #[test]
    fn a_variant_is_resolved_from_the_tree_and_the_answer_written_into_it() {
        let e = env();
        create(&e, Some("site"));
        let t = e.store.claim(None, "s1", 1000).unwrap().unwrap();
        variant_tree(&tree(&t));
        let (_, batch) = e
            .store
            .post(
                CallPostParams {
                    task: t.id.clone(),
                    session: "s1".into(),
                    wait: Wait::Record,
                    summary: None,
                    calls: vec![variant_call(Wait::Review)],
                    hold_ms: None,
                    replaces: None,
                },
                2000,
            )
            .unwrap();
        let c = &batch.calls[0];
        assert_eq!(c.options, ["raised", "recessed"]);
        assert_eq!(
            c.choice.as_deref(),
            Some("recessed"),
            "the block's current content"
        );
        assert_eq!(
            c.variant.as_ref().unwrap().file,
            "services/site/t/a.user.css"
        );

        let (b, _, _) = e
            .store
            .answer(
                CallAnswerParams {
                    batch: batch.id,
                    answers: vec![AnswerInput {
                        choice: Some("raised".into()),
                        note: None,
                    }],
                },
                None,
                3000,
            )
            .unwrap();
        assert!(b.calls[0].answer.as_ref().unwrap().applied);
        let text = fs::read_to_string(tree(&t).join("services/site/t/a.user.css")).unwrap();
        assert!(
            text.contains("#313244") && !text.contains("#181825"),
            "{text}"
        );
        assert!(text.contains("/* atelier:end cards */"));
    }

    #[test]
    fn after_landing_a_different_variant_lands_without_an_agent() {
        let e = env();
        create(&e, Some("site"));
        let t = e.store.claim(None, "s1", 1000).unwrap().unwrap();
        variant_tree(&tree(&t));
        let (_, batch) = e
            .store
            .post(
                CallPostParams {
                    task: t.id.clone(),
                    session: "s1".into(),
                    wait: Wait::Record,
                    summary: None,
                    calls: vec![variant_call(Wait::Record)],
                    hold_ms: None,
                    replaces: None,
                },
                2000,
            )
            .unwrap();
        super::super::tests::submit(&e, &t.id);
        let (b, _, revisions) = e
            .store
            .answer(
                CallAnswerParams {
                    batch: batch.id,
                    answers: vec![AnswerInput {
                        choice: Some("raised".into()),
                        note: None,
                    }],
                },
                None,
                3000,
            )
            .unwrap();
        assert!(b.calls[0].answer.as_ref().unwrap().applied);
        assert!(revisions.is_empty(), "nothing left for an agent to do");
        let text = fs::read_to_string(e.dir.join("services/site/t/a.user.css")).unwrap();
        assert!(text.contains("#313244"), "{text}");
        // It's in the journal like any landing, so it can be undone.
        e.store.undo(None, 4000).unwrap();
        let text = fs::read_to_string(e.dir.join("services/site/t/a.user.css")).unwrap();
        assert!(text.contains("#181825"), "{text}");
    }

    #[test]
    fn a_choice_with_reasons_is_trimmed_to_its_option() {
        let mut c = call("q", Some("mauve: it matches the header"));
        normalise_choice(&mut c);
        assert_eq!(c.choice.as_deref(), Some("mauve"));
        assert!(c.context.unwrap().contains("it matches the header"));
    }

    #[test]
    fn attachments_must_come_from_the_task() {
        let e = env();
        create(&e, Some("site"));
        let t = e.store.claim(None, "s1", 1000).unwrap().unwrap();
        let mut c = call("q", None);
        c.attachments = vec![e.dir.join("atelier.toml").display().to_string()];
        let r = e.store.post(
            CallPostParams {
                task: t.id,
                session: "s1".into(),
                wait: Wait::Block,
                summary: None,
                calls: vec![c],
                hold_ms: None,
                replaces: None,
            },
            2000,
        );
        assert!(r.unwrap_err().contains("isn't in the task's directory"));
    }
}
