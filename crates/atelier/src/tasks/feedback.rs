//! Feedback from agents to atelier's developers (SPEC §9.4). Sessions end,
//! and their conversations with them, so what an agent has to say about the
//! tools is kept in `feedback/<id>.json` in the state directory until the
//! user has passed it on (`atelier feedback`, or the inbox).

use super::{Result, Store, err, new_id, write_atomic};
use atelier_proto::Feedback;
use std::fs;
use std::path::PathBuf;

impl Store {
    fn feedback_path(&self, id: &str) -> Result<PathBuf> {
        if id.is_empty() || id.contains(['/', '.']) {
            return Err(format!("no feedback `{id}`"));
        }
        Ok(self.state.join("feedback").join(format!("{id}.json")))
    }

    fn save_feedback(&self, f: &Feedback) -> Result<()> {
        let path = self.feedback_path(&f.id)?;
        fs::create_dir_all(path.parent().expect("has parent")).map_err(err)?;
        write_atomic(
            &path,
            serde_json::to_string_pretty(f).map_err(err)?.as_bytes(),
        )
        .map_err(err)
    }

    /// Keeps a note from an agent, with what it was working on.
    pub fn post_feedback(
        &self,
        text: &str,
        session: Option<String>,
        task: Option<String>,
        theme: Option<String>,
        now: u64,
    ) -> Result<Feedback> {
        let text = text.trim();
        if text.is_empty() {
            return Err("feedback needs some text".into());
        }
        let service = task
            .as_deref()
            .and_then(|t| self.get(t).ok())
            .and_then(|t| t.service);
        let f = Feedback {
            id: new_id(now).replacen('t', "f", 1),
            text: text.to_string(),
            created: now,
            session,
            task,
            service,
            theme,
            read: None,
        };
        self.save_feedback(&f)?;
        Ok(f)
    }

    /// Feedback, newest first: only what hasn't been read, unless `all`.
    pub fn feedback(&self, all: bool) -> Result<Vec<Feedback>> {
        let mut out: Vec<Feedback> = fs::read_dir(self.state.join("feedback"))
            .into_iter()
            .flatten()
            .flatten()
            .filter_map(|e| fs::read_to_string(e.path()).ok())
            .filter_map(|t| serde_json::from_str::<Feedback>(&t).ok())
            .filter(|f| all || f.read.is_none())
            .collect();
        out.sort_by(|a, b| (b.created, &b.id).cmp(&(a.created, &a.id)));
        Ok(out)
    }

    /// Marks feedback read: the user has passed it on.
    pub fn read_feedback(&self, ids: &[String], now: u64) -> Result<Vec<Feedback>> {
        let mut out = Vec::new();
        for id in ids {
            let text = fs::read_to_string(self.feedback_path(id)?)
                .map_err(|_| format!("no feedback `{id}`"))?;
            let mut f: Feedback = serde_json::from_str(&text).map_err(err)?;
            f.read.get_or_insert(now);
            self.save_feedback(&f)?;
            out.push(f);
        }
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::super::tests::{create, env};

    #[test]
    fn feedback_is_kept_with_its_task_until_read() {
        let e = env();
        let t = create(&e, Some("site"));
        let f = e
            .store
            .post_feedback(
                "  task_info was confusing  ",
                Some("s1".into()),
                Some(t.id.clone()),
                Some("t".into()),
                1000,
            )
            .unwrap();
        assert_eq!(f.text, "task_info was confusing");
        assert_eq!(f.service.as_deref(), Some("site"));
        assert!(f.id.starts_with('f'));
        assert!(e.store.post_feedback(" ", None, None, None, 1000).is_err());
        assert_eq!(e.store.feedback(false).unwrap(), std::slice::from_ref(&f));
        e.store
            .read_feedback(std::slice::from_ref(&f.id), 2000)
            .unwrap();
        assert!(e.store.feedback(false).unwrap().is_empty());
        assert_eq!(e.store.feedback(true).unwrap()[0].read, Some(2000));
    }
}
