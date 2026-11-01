//! What a landing changed, as a diff: for an agent revisiting an earlier
//! task's calls, which needs to see what that task actually wrote, not only
//! what it said it chose. Made from the journal's before and after copies.

use super::{Result, Store};
use std::fmt::Write;
use std::fs;
use std::path::Path;

/// Files larger than this (in lines, old times new) aren't diffed line by
/// line.
const MAX_CELLS: usize = 4_000_000;
const CONTEXT: usize = 3;

impl Store {
    /// The unified diff of a task's landing (its latest, if it landed more
    /// than once), or None if the journal has no landing for it.
    pub fn landing_diff(&self, task: &str) -> Result<Option<String>> {
        for seq in self.journal_seqs()?.into_iter().rev() {
            let rec = self.load_record(seq)?;
            if rec.entry.task.as_deref() != Some(task) || rec.entry.undo_of.is_some() {
                continue;
            }
            let dir = self.state.join("journal").join(seq.to_string());
            let mut out = format!(
                "What task {task} changed when it landed (journal entry {seq}): {}\n",
                rec.entry.summary
            );
            if let Some(by) = rec.entry.undone_by {
                let _ = writeln!(out, "It has been undone since, by journal entry {by}.");
            }
            for (path, f) in &rec.files {
                let read = |p: &Path| fs::read(p).ok();
                let old = f
                    .existed
                    .then(|| read(&dir.join("before").join(path)))
                    .flatten();
                let new = f
                    .after
                    .is_some()
                    .then(|| read(&dir.join("after").join(path)))
                    .flatten();
                let text = |b: &Option<Vec<u8>>| match b {
                    None => Some(String::new()),
                    Some(b) => String::from_utf8(b.clone()).ok(),
                };
                out.push('\n');
                match (text(&old), text(&new)) {
                    (Some(o), Some(n)) => out.push_str(&unified(path, &o, &n)),
                    _ => {
                        let what = match (&old, &new) {
                            (None, _) => "added",
                            (_, None) => "deleted",
                            _ => "changed",
                        };
                        let _ = writeln!(out, "{path}: {what} (not text)");
                    }
                }
            }
            return Ok(Some(out));
        }
        Ok(None)
    }
}

/// A unified diff of two texts, with three lines of context.
pub fn unified(path: &str, old: &str, new: &str) -> String {
    let a: Vec<&str> = old.lines().collect();
    let b: Vec<&str> = new.lines().collect();
    let (old_name, new_name) = (
        if old.is_empty() {
            "/dev/null".to_string()
        } else {
            format!("a/{path}")
        },
        if new.is_empty() {
            "/dev/null".to_string()
        } else {
            format!("b/{path}")
        },
    );
    let mut out = format!("--- {old_name}\n+++ {new_name}\n");
    // Lines alike at both ends needn't go through the table.
    let mut pre = 0;
    while pre < a.len() && pre < b.len() && a[pre] == b[pre] {
        pre += 1;
    }
    let mut suf = 0;
    while suf < a.len() - pre && suf < b.len() - pre && a[a.len() - 1 - suf] == b[b.len() - 1 - suf]
    {
        suf += 1;
    }
    let (ma, mb) = (&a[pre..a.len() - suf], &b[pre..b.len() - suf]);
    if ma.len() * mb.len() > MAX_CELLS {
        let _ = writeln!(
            out,
            "(too much changed to show line by line: {} lines before, {} after)",
            a.len(),
            b.len()
        );
        return out;
    }
    // Longest common subsequence, from the end.
    let (n, m) = (ma.len(), mb.len());
    let at = |i: usize, j: usize| i * (m + 1) + j;
    let mut t = vec![0u32; (n + 1) * (m + 1)];
    for i in (0..n).rev() {
        for j in (0..m).rev() {
            t[at(i, j)] = if ma[i] == mb[j] {
                t[at(i + 1, j + 1)] + 1
            } else {
                t[at(i + 1, j)].max(t[at(i, j + 1)])
            };
        }
    }
    let mut ops: Vec<(char, &str)> = a[..pre].iter().map(|l| (' ', *l)).collect();
    let (mut i, mut j) = (0, 0);
    while i < n || j < m {
        if i < n && j < m && ma[i] == mb[j] {
            ops.push((' ', ma[i]));
            i += 1;
            j += 1;
        } else if i < n && (j == m || t[at(i + 1, j)] >= t[at(i, j + 1)]) {
            ops.push(('-', ma[i]));
            i += 1;
        } else {
            ops.push(('+', mb[j]));
            j += 1;
        }
    }
    ops.extend(a[a.len() - suf..].iter().map(|l| (' ', *l)));

    let changes: Vec<usize> = (0..ops.len()).filter(|&k| ops[k].0 != ' ').collect();
    let mut k = 0;
    while k < changes.len() {
        let start = changes[k].saturating_sub(CONTEXT);
        let mut last = changes[k];
        while k + 1 < changes.len() && changes[k + 1] <= last + 2 * CONTEXT + 1 {
            k += 1;
            last = changes[k];
        }
        let end = (last + 1 + CONTEXT).min(ops.len());
        let before = |kind: char| {
            ops[..start]
                .iter()
                .filter(|o| o.0 == ' ' || o.0 == kind)
                .count()
        };
        let count = |kind: char| {
            ops[start..end]
                .iter()
                .filter(|o| o.0 == ' ' || o.0 == kind)
                .count()
        };
        let (oc, nc) = (count('-'), count('+'));
        let line = |skipped: usize, count: usize| if count == 0 { skipped } else { skipped + 1 };
        let _ = writeln!(
            out,
            "@@ -{},{oc} +{},{nc} @@",
            line(before('-'), oc),
            line(before('+'), nc)
        );
        for (kind, text) in &ops[start..end] {
            let _ = writeln!(out, "{kind}{text}");
        }
        k += 1;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::unified;

    #[test]
    fn a_diff_shows_changes_with_context_in_hunks() {
        let old: String = (1..=20).map(|i| format!("line {i}\n")).collect();
        let new = old
            .replace("line 2\n", "line two\n")
            .replace("line 17\n", "")
            .replace("line 20\n", "line 20\nline 21\n");
        assert_eq!(
            unified("s.css", &old, &new),
            "--- a/s.css\n+++ b/s.css\n\
             @@ -1,5 +1,5 @@\n line 1\n-line 2\n+line two\n line 3\n line 4\n line 5\n\
             @@ -14,7 +14,7 @@\n line 14\n line 15\n line 16\n-line 17\n line 18\n line 19\n line 20\n+line 21\n"
        );
        assert_eq!(
            unified("new.css", "", "a\n"),
            "--- /dev/null\n+++ b/new.css\n@@ -0,0 +1,1 @@\n+a\n"
        );
    }
}
