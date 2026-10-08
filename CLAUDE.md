# atelier

- `SPEC.md`: what atelier is and how it's designed. Read it before changing anything substantial.
- `ARCHITECTURE.md`: how the code is shaped (the page model, state and recovery) and the invariants that keep it correct. Read it before adding a page-side feature or anything that creates state.
- `DEVELOPING.md`: repo layout, and how to run and test atelier in an isolated dev environment. Never test against the user's own browser profile or home directory.
- `PROMPTING.md`: how to think about the agents that atelier invokes, and how to write prompts, skills, tool descriptions and briefs for them.
- `AGENT-EXPERIENCE.md`: where the ideas in `PROMPTING.md` apply in atelier (briefs, MCP tools, errors, the kit).
