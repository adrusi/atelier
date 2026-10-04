//! Calls: the decisions agents faced, posted in batches (SPEC §9.5).
//!
//! A batch lives with its task, in `tasks/<task>/calls/<n>/`: `batch.json`
//! and the attachments copied in when it was posted. Its id is
//! `<task>-q<n>`. A `review` or `block` batch parks the task (`Waiting`)
//! until it's answered; then the task goes back to the queue with its tree,
//! and whoever claims it sees the answers. Answering a `record` batch for a
//! task that has landed queues a `revise` for each call the user changed.

use super::{Result, Store, err, write_atomic};
use atelier_proto::{
    Addressee, Answer, Batch, BatchState, BlobChunk, CallAnswerParams, CallPostParams, CallStats,
    Task, TaskBrief, TaskCreateParams, TaskKind, TaskState, Wait,
};
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
        let n = self.next_batch(&task.id);
        let dir = self.batch_dir(&task.id, n);
        let task_dir = self.task_dir(&task.id).canonicalize().map_err(err)?;
        let mut calls = p.calls;
        for (i, call) in calls.iter_mut().enumerate() {
            call.answer = None;
            call.wait = Some(call.wait.unwrap_or(p.wait));
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
            task.state = TaskState::Waiting;
            task.lease = None;
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
    /// queue, and any `revise` tasks queued for record calls the user
    /// changed after the work landed.
    pub fn answer(
        &self,
        p: CallAnswerParams,
        theme: Option<String>,
        now: u64,
    ) -> Result<(Batch, Option<Task>, Vec<Task>)> {
        let mut batch = self.batch(&p.batch)?;
        if batch.state != BatchState::Open {
            return Err(format!("batch {} has already been answered", batch.id));
        }
        if p.answers.len() > batch.calls.len() {
            return Err(format!(
                "batch {} has {} calls, but {} answers were given",
                batch.id,
                batch.calls.len(),
                p.answers.len()
            ));
        }
        for (i, call) in batch.calls.iter_mut().enumerate() {
            let input = p.answers.get(i).cloned().unwrap_or_default();
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
                time: now,
            });
        }
        batch.state = BatchState::Answered;
        batch.answered = Some(now);
        self.save_batch(&batch)?;

        let mut task = self.get(&batch.task)?;
        let mut requeued = None;
        if task.state == TaskState::Waiting
            && self
                .batches(true, Some(&task.id))?
                .iter()
                .all(|b| b.wait == Wait::Record)
        {
            task.state = TaskState::Queued;
            task.updated = now;
            self.save(&task)?;
            requeued = Some(task.clone());
        }
        let mut revisions = Vec::new();
        if task.state == TaskState::Landed {
            for call in batch.calls.iter().filter(|c| c.wait == Some(Wait::Record)) {
                let Some(a) = call.answer.as_ref().filter(|a| !a.kept) else {
                    continue;
                };
                let mut said = Vec::new();
                if a.choice != call.choice
                    && let Some(c) = &a.choice
                {
                    said.push(format!("they chose: {c}"));
                }
                if let Some(n) = &a.note {
                    said.push(format!("they said: {n}"));
                }
                let made = call.choice.as_deref().unwrap_or("(no choice recorded)");
                revisions.push(self.create(
                    TaskCreateParams {
                        kind: TaskKind::Revise,
                        service: task.service.clone(),
                        brief: TaskBrief {
                            description: format!(
                                "Revisit a call from an earlier task ({}): {}",
                                task.id, call.question
                            ),
                            origin: task.brief.origin.clone(),
                            note: Some(format!(
                                "The agent went with: {made}. Looking at it afterwards, {}.",
                                said.join("; ")
                            )),
                            container: task.brief.container.clone(),
                            attachments: Vec::new(),
                        },
                        uploads: Vec::new(),
                    },
                    theme.clone(),
                    now,
                )?);
            }
        }
        Ok((batch, requeued, revisions))
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
            },
            2000,
        );
        assert!(r.unwrap_err().contains("isn't in the task's directory"));
    }
}
