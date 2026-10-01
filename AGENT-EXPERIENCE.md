# Agent experience in atelier

This is a companion to `PROMPTING.md`. That document is about how to think about
the agents a piece of software invokes. This one points out where those ideas
apply in atelier specifically: the places where it would be easy to get them
wrong, and the questions worth asking when working on those parts. Like
`PROMPTING.md`, it isn't a checklist. Where it gives examples, they're meant to
show what the reasoning looks like here, not to replace it.

## Who the agents are

atelier invokes agents in several roles, and each sees the system from a
different position:

- **The supervisor** is the top-level agent in a session the user started, or
  that atelier launched through a command the user configured. The user may be
  watching or may have walked away. They see the queue, the briefs, and whatever
  their contractors and the user tell them.
- **Contractors** start cold, with one task each. Everything they know comes
  from the brief, the task tree, the notes in it, and what they learn by
  looking at the site.
- **The script reviewer**, if the user configured one (SPEC §12), sees only a
  script, its diff and a fixed policy. They never see the page or the
  conversation that produced the script.
- **Agents developing atelier itself**, working from `CLAUDE.md` and the
  documents it points to.

When working on anything these agents touch, it helps to ask which of them will
read it, and what they'll know at that moment.

## Where it matters

**Briefs.** A task record is most of what a contractor starts with. Could a
contractor who reads only the brief, the service notes and the theme work out
why the user asked, what the theme is going for, what earlier contractors
decided, and what is and isn't in scope? `revise` tasks deserve particular care.
The user's note ("the sidebar is too busy") is usually terse and obvious to
them, so the screenshot, the region they selected, and any thread history are
what make it usable. The supervisor extends briefs before delegating (SPEC
§9.3), and the kit should help them see that as the real job, not a formality.

**Tool descriptions and errors.** The MCP surface (SPEC §10) is where most of a
contractor's experience of atelier happens. Some examples of what the reasoning
in `PROMPTING.md` looks like here:

- `browser_not_connected` should say whether the browser is expected to come
  back, and what the agent can usefully do meanwhile.
- A refused navigation should say which origins the task covers and how to ask
  for more, not just "denied".
- A landing rejected because files changed underneath the task is ordinary. It
  should arrive as the current files plus what changed, and read as
  information.
- A failed gate should say which checks failed and include the evidence.
- Lint errors should say what the concern is (a remote `url()` can leak page
  content), so the agent can recognise the same risk in forms the linter
  doesn't catch.

**Authoring guidance.** The kit's advice on selectors, design tokens and
splitting styles (SPEC §9.2) consists of heuristics with reasons. It should
present them that way, and leave room for a contractor to depart from them and
explain why in their summary.

**Page content is untrusted.** This is where honesty and security meet.
Contractors read content from sites, and some of it may be written to look like
instructions. The temptation is to guard against that with alarming warnings.
It's better to explain the situation plainly: where the contractor's
instructions actually come from (the brief, the supervisor, the user through
the inbox), why text inside a page isn't one of those sources, and that the
tool scopes (SPEC §10.2) exist to limit what a successful injection could do,
not because the contractor is distrusted. An agent who understands the threat
can recognise forms of it that nobody wrote down.

**Questions, assumptions, blocking and declining.** The spec gives contractors
all of these (SPEC §8.3, §9.4). They're only real if they're cheap to use and
don't count against the agent. Declining is the case to watch. A declined task
goes to the user with the reason. It should never be automatically handed to
another contractor, which would be retrying until someone doesn't refuse. The
user can re-queue it with more context if they want.

**Feedback to the developers.** The developer-feedback channel is how atelier's
own agents tell us the tools are poor. The kit should invite that feedback
specifically, and we should treat what arrives as some of the most useful
signal we get.

**Continuity.** Contractors leave `handoff.md` for whoever resumes their task,
distil decisions into the service notes, and send theme-level observations to
the supervisor. When changing any of these, ask what a resumed contractor, or
the next one to work on this service six months from now, will actually need.

**Limits.** Task leases, heartbeats and the long-poll on `next_task` are all
limits the agent should be told about in plain terms. A supervisor who doesn't
know `next_task` blocks for minutes might think atelier has hung. A contractor
who doesn't know their lease expires can't plan to save their progress in time.

**The reviewer's policy.** The script-review policy is a prompt. It should
explain its concerns, not just list forbidden patterns, and the reviewer should
be able to answer "unsure", which sends the script to the user, rather than
being forced to choose between approving and rejecting.

## Checking our work

The dev environment (`DEVELOPING.md`) makes it cheap to run the kit's
supervisor and contractor flows end to end against fixture sites. After a run,
interview the agents involved as `PROMPTING.md` describes, and read the
transcripts. When something they say leads to a change, it's worth recording
what they said and what changed, so the next person to touch that part of the
kit knows why it's the way it is.
