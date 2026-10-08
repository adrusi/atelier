//! Proposed edits to a theme's files (SPEC §9.5).
//!
//! THEME.md is the user's: agents never land changes to it. They propose
//! edits, as find-and-replace against its current text, and the user
//! accepts (perhaps after editing the result), or declines with a note.
//! Accepting lands the file through the journal like any other change, so
//! it can be undone and the user's hooks see it.
//!
//! The theme's notes.md holds design notes: calls about applying the theme
//! (what counts as "current", how wide a header strip runs), so that work on
//! every site is consistent. Agents propose to it the same way, but those
//! proposals land at once, through the journal (so the user can review and
//! undo them), without waiting. Proposals live in `proposals/<id>.json` in
//! the state directory.

use super::{FileRecord, Followup, Result, Store, err, new_id, write_atomic};
use atelier_proto::{
    ChangeKind, DecideParams, FileChange, JournalEntry, Proposal, ProposalState, ProposeParams,
    ThemeFile,
};
use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;

impl Store {
    fn proposal_path(&self, id: &str) -> Result<PathBuf> {
        if id.is_empty() || id.contains(['/', '.']) {
            return Err(format!("no proposal `{id}`"));
        }
        Ok(self.state.join("proposals").join(format!("{id}.json")))
    }

    fn save_proposal(&self, p: &Proposal) -> Result<()> {
        let path = self.proposal_path(&p.id)?;
        fs::create_dir_all(path.parent().expect("has parent")).map_err(err)?;
        write_atomic(
            &path,
            serde_json::to_string_pretty(p).map_err(err)?.as_bytes(),
        )
        .map_err(err)
    }

    /// Proposes edits to one of the theme's files, applied to its current
    /// text. A proposal to the design notes lands at once; the returned
    /// proposal is then accepted, with its journal entry.
    pub fn propose(&self, theme: &str, p: ProposeParams, now: u64) -> Result<Proposal> {
        super::check_name("theme", theme)?;
        if p.summary.trim().is_empty() {
            return Err("a proposal needs a summary: what changes, in a line".into());
        }
        let name = match p.file {
            ThemeFile::Theme => "THEME.md",
            ThemeFile::Notes => "notes.md",
        };
        let path = format!("themes/{theme}/{name}");
        let before = fs::read_to_string(self.dir.join(&path)).unwrap_or_default();
        let mut after = before.clone();
        for (i, e) in p.edits.iter().enumerate() {
            match e.find.as_deref().filter(|f| !f.is_empty()) {
                Some(find) => match after.matches(find).count() {
                    1 => after = after.replacen(find, &e.replace, 1),
                    0 => {
                        return Err(format!(
                            "edit {}: its `find` text isn't in {name} as it is now; the current text follows, so you can match it exactly\n\n{before}",
                            i + 1
                        ));
                    }
                    n => {
                        return Err(format!(
                            "edit {}: its `find` text occurs {n} times in {name}; include more of the surrounding text so it's unique",
                            i + 1
                        ));
                    }
                },
                None => {
                    if !after.is_empty() && !after.ends_with('\n') {
                        after.push('\n');
                    }
                    after.push_str(&e.replace);
                }
            }
        }
        if after == before {
            return Err(format!("these edits don't change {name}"));
        }
        let proposal = Proposal {
            id: new_id(now).replacen('t', "p", 1),
            theme: theme.to_string(),
            path,
            before,
            after,
            summary: p.summary.trim().to_string(),
            why: p.why.filter(|w| !w.trim().is_empty()),
            task: p.task,
            state: ProposalState::Open,
            note: None,
            journal: None,
            created: now,
            decided: None,
            reviewed: false,
        };
        self.save_proposal(&proposal)?;
        if p.file == ThemeFile::Notes {
            let accepted = Followup::Accepted {
                proposal: proposal.id.clone(),
            };
            let summary = format!("{}: {}", proposal.path, proposal.summary);
            self.land_text(
                &proposal.path,
                &proposal.after,
                &summary,
                proposal.task.clone(),
                vec![accepted],
                now,
            )?;
            let mut landed = self.proposal(&proposal.id)?;
            landed.decided = Some(now);
            self.save_proposal(&landed)?;
            return Ok(landed);
        }
        Ok(proposal)
    }

    fn proposal(&self, id: &str) -> Result<Proposal> {
        serde_json::from_str(
            &fs::read_to_string(self.proposal_path(id)?)
                .map_err(|_| format!("no proposal `{id}`"))?,
        )
        .map_err(err)
    }

    /// The follow-up of a proposal's landing (see `finish`): it's accepted,
    /// as journal entry `seq`.
    pub(super) fn accepted(&self, id: &str, seq: u64) -> Result<()> {
        let mut p = self.proposal(id)?;
        p.state = ProposalState::Accepted;
        p.journal = Some(seq);
        self.save_proposal(&p)
    }

    /// The user has looked at an addition to the design notes: kept, or
    /// undone through the journal. Returns the proposal and any undo entry.
    pub fn review(
        &self,
        id: &str,
        undo: bool,
        now: u64,
    ) -> Result<(Proposal, Option<JournalEntry>)> {
        let mut p = self.proposal(id)?;
        if !p.path.ends_with("/notes.md") || p.state != ProposalState::Accepted {
            return Err(format!(
                "proposal {id} isn't an addition to the design notes"
            ));
        }
        let entry = match (undo, p.journal) {
            (true, Some(seq)) => Some(self.undo(Some(seq), now)?),
            _ => None,
        };
        p = self.proposal(id)?;
        p.reviewed = true;
        if undo {
            p.note = Some("undone by the user".into());
        }
        self.save_proposal(&p)?;
        Ok((p, entry))
    }

    /// Proposals, newest first; with `open_only`, those still undecided.
    pub fn proposals(&self, open_only: bool) -> Result<Vec<Proposal>> {
        let mut out: Vec<Proposal> = match fs::read_dir(self.state.join("proposals")) {
            Ok(d) => d
                .flatten()
                .filter_map(|e| fs::read_to_string(e.path()).ok())
                .filter_map(|t| serde_json::from_str(&t).ok())
                .collect(),
            Err(_) => Vec::new(),
        };
        out.retain(|p: &Proposal| !open_only || p.state == ProposalState::Open);
        out.sort_by(|a, b| (b.created, &b.id).cmp(&(a.created, &a.id)));
        Ok(out)
    }

    /// The user's decision. Accepting lands the text (theirs, if they edited
    /// it) provided THEME.md hasn't changed since the proposal was made.
    /// Returns the proposal and, when accepted, the journal entry.
    pub fn decide(&self, d: DecideParams, now: u64) -> Result<(Proposal, Option<JournalEntry>)> {
        let path = self.proposal_path(&d.id)?;
        let mut p: Proposal = serde_json::from_str(
            &fs::read_to_string(&path).map_err(|_| format!("no proposal `{}`", d.id))?,
        )
        .map_err(err)?;
        if p.state != ProposalState::Open {
            return Err(format!("proposal {} has already been decided", p.id));
        }
        p.note = d.note.filter(|n| !n.trim().is_empty());
        p.decided = Some(now);
        let mut entry = None;
        if d.accept {
            let current = fs::read_to_string(self.dir.join(&p.path)).unwrap_or_default();
            if current != p.before {
                p.state = ProposalState::Stale;
                self.save_proposal(&p)?;
                return Err(format!(
                    "{} has changed since this was proposed, so it can't be applied as it stands",
                    p.path
                ));
            }
            let text = d.text.unwrap_or_else(|| p.after.clone());
            let summary = format!("{}: {}", p.path, p.summary);
            // The note first; the acceptance itself is part of the landing,
            // so a crash between the two can't leave THEME.md changed and
            // the proposal still open.
            self.save_proposal(&p)?;
            let accepted = Followup::Accepted {
                proposal: p.id.clone(),
            };
            entry = Some(self.land_text(
                &p.path,
                &text,
                &summary,
                p.task.clone(),
                vec![accepted],
                now,
            )?);
            let p = self.proposal(&p.id)?;
            return Ok((p, entry));
        }
        p.state = ProposalState::Declined;
        self.save_proposal(&p)?;
        Ok((p, entry))
    }

    /// Writes one file of the owned directory on the user's say-so, through
    /// the journal: recorded first (so it can be undone), then written.
    pub(super) fn land_text(
        &self,
        rel: &str,
        text: &str,
        summary: &str,
        task: Option<String>,
        then: Vec<Followup>,
        now: u64,
    ) -> Result<JournalEntry> {
        let dst = self.dir.join(rel);
        let existed = dst.is_file();
        let seq = self.next_seq()?;
        let changes = vec![FileChange {
            path: rel.to_string(),
            change: if existed {
                ChangeKind::Modified
            } else {
                ChangeKind::Added
            },
        }];
        let entry = JournalEntry {
            seq,
            task,
            summary: summary.to_string(),
            time: now,
            files: changes,
            undone_by: None,
            undo_of: None,
        };
        let after = {
            use sha2::{Digest, Sha256};
            Sha256::digest(text.as_bytes())
                .iter()
                .map(|b| format!("{b:02x}"))
                .collect::<String>()
        };
        let mut files = BTreeMap::new();
        files.insert(
            rel.to_string(),
            FileRecord {
                existed: false,
                after: Some(after),
            },
        );
        let afters = BTreeMap::from([(rel.to_string(), text.as_bytes().to_vec())]);
        self.record(seq, entry.clone(), files, &afters, then)?;
        self.finish(seq)?;
        self.prune_journal(now);
        Ok(entry)
    }
}

#[cfg(test)]
mod tests {
    use super::super::tests::{env, put};
    use super::*;
    use atelier_proto::TextEdit;

    fn edit(find: Option<&str>, replace: &str) -> TextEdit {
        TextEdit {
            find: find.map(str::to_string),
            replace: replace.into(),
        }
    }

    fn propose(e: &super::super::tests::Env, edits: Vec<TextEdit>) -> Result<Proposal> {
        e.store.propose(
            "t",
            ProposeParams {
                edits,
                summary: "cards".into(),
                why: Some("crates.io".into()),
                task: None,
                file: ThemeFile::Theme,
            },
            1000,
        )
    }

    #[test]
    fn an_accepted_proposal_lands_and_can_be_undone() {
        let e = env();
        put(&e.dir, "themes/t/THEME.md", "# t\n\nCards are surface0.\n");
        let p = propose(
            &e,
            vec![
                edit(
                    Some("Cards are surface0."),
                    "Cards are surface0, unless the site draws them darker.",
                ),
                edit(None, "\nNo pure black.\n"),
            ],
        )
        .unwrap();
        assert_eq!(
            p.after,
            "# t\n\nCards are surface0, unless the site draws them darker.\n\nNo pure black.\n"
        );
        // Nothing changes until the user says so.
        assert_eq!(
            fs::read_to_string(e.dir.join("themes/t/THEME.md")).unwrap(),
            p.before
        );
        let (p, entry) = e
            .store
            .decide(
                DecideParams {
                    id: p.id,
                    accept: true,
                    note: None,
                    text: None,
                },
                2000,
            )
            .unwrap();
        assert_eq!(p.state, ProposalState::Accepted);
        assert_eq!(
            fs::read_to_string(e.dir.join("themes/t/THEME.md")).unwrap(),
            p.after
        );
        assert_eq!(p.journal, entry.map(|e| e.seq));
        e.store.undo(None, 3000).unwrap();
        assert_eq!(
            fs::read_to_string(e.dir.join("themes/t/THEME.md")).unwrap(),
            p.before
        );
    }

    #[test]
    fn edits_must_match_once_and_stale_proposals_are_refused() {
        let e = env();
        put(&e.dir, "themes/t/THEME.md", "a\na\n");
        assert!(
            propose(&e, vec![edit(Some("a"), "b")])
                .unwrap_err()
                .contains("occurs 2 times")
        );
        assert!(
            propose(&e, vec![edit(Some("zzz"), "b")])
                .unwrap_err()
                .contains("isn't in THEME.md")
        );
        let p = propose(&e, vec![edit(None, "c\n")]).unwrap();
        put(&e.dir, "themes/t/THEME.md", "edited by hand\n");
        let r = e.store.decide(
            DecideParams {
                id: p.id.clone(),
                accept: true,
                note: None,
                text: None,
            },
            2000,
        );
        assert!(r.unwrap_err().contains("has changed since"));
        assert_eq!(
            e.store.proposals(false).unwrap()[0].state,
            ProposalState::Stale
        );
    }

    #[test]
    fn design_notes_land_at_once_and_can_be_undone_on_review() {
        let e = env();
        put(&e.dir, "themes/t/THEME.md", "# t\n");
        let notes = |p: Result<Proposal>| p.unwrap();
        let p = notes(e.store.propose(
            "t",
            ProposeParams {
                edits: vec![edit(None, "- Anchor targets count as current.\n")],
                summary: "anchors".into(),
                why: None,
                task: None,
                file: ThemeFile::Notes,
            },
            1000,
        ));
        assert_eq!(p.path, "themes/t/notes.md");
        assert_eq!(p.state, ProposalState::Accepted);
        assert!(!p.reviewed);
        let path = e.dir.join("themes/t/notes.md");
        assert_eq!(
            fs::read_to_string(&path).unwrap(),
            "- Anchor targets count as current.\n"
        );
        assert!(
            e.store.proposals(true).unwrap().is_empty(),
            "nothing waits for the user"
        );

        let (p, undo) = e.store.review(&p.id, true, 2000).unwrap();
        assert!(p.reviewed && undo.is_some());
        assert!(
            !path.exists(),
            "undoing the first note removes the file it created"
        );
        assert!(
            e.store.review(&p.id, false, 3000).is_ok(),
            "reviewing again is harmless"
        );

        // THEME.md proposals still wait.
        let t = propose(&e, vec![edit(None, "More.\n")]).unwrap();
        assert_eq!(t.state, ProposalState::Open);
        assert!(e.store.review(&t.id, false, 4000).is_err());
    }
}
