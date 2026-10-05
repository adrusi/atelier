//! Proposed edits to THEME.md (SPEC §9.5).
//!
//! THEME.md is the user's: agents never land changes to it. They propose
//! edits, as find-and-replace against its current text, and the user
//! accepts (perhaps after editing the result), or declines with a note.
//! Accepting lands the file through the journal like any other change, so
//! it can be undone and the user's hooks see it. Proposals live in
//! `proposals/<id>.json` in the state directory.

use super::{FileRecord, Result, Store, err, hash_file, new_id, write_atomic};
use atelier_proto::{
    ChangeKind, DecideParams, FileChange, JournalEntry, Proposal, ProposalState, ProposeParams,
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

    /// Proposes edits to the theme's THEME.md, applied to its current text.
    pub fn propose(&self, theme: &str, p: ProposeParams, now: u64) -> Result<Proposal> {
        super::check_name("theme", theme)?;
        if p.summary.trim().is_empty() {
            return Err("a proposal needs a summary: what changes, in a line".into());
        }
        let path = format!("themes/{theme}/THEME.md");
        let before = fs::read_to_string(self.dir.join(&path)).unwrap_or_default();
        let mut after = before.clone();
        for (i, e) in p.edits.iter().enumerate() {
            match e.find.as_deref().filter(|f| !f.is_empty()) {
                Some(find) => match after.matches(find).count() {
                    1 => after = after.replacen(find, &e.replace, 1),
                    0 => {
                        return Err(format!(
                            "edit {}: its `find` text isn't in THEME.md as it is now; the current text follows, so you can match it exactly\n\n{before}",
                            i + 1
                        ));
                    }
                    n => {
                        return Err(format!(
                            "edit {}: its `find` text occurs {n} times in THEME.md; include more of the surrounding text so it's unique",
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
            return Err("these edits don't change THEME.md".into());
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
        };
        self.save_proposal(&proposal)?;
        Ok(proposal)
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
            let e = self.land_text(&p.path, &text, &summary, p.task.clone(), now)?;
            p.journal = Some(e.seq);
            p.state = ProposalState::Accepted;
            entry = Some(e);
        } else {
            p.state = ProposalState::Declined;
        }
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
        self.record(seq, entry.clone(), files)?;
        fs::create_dir_all(dst.parent().expect("has parent")).map_err(err)?;
        write_atomic(&dst, text.as_bytes()).map_err(err)?;
        debug_assert!(hash_file(&dst).is_ok());
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
}
