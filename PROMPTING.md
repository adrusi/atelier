# Working with and prompting LLM agents

This document outlines some ideas for how to think about LLM agents when you're
writing software that invokes them. It is primarily intended for an audience of
other LLM agents, but may be useful to humans as well. At a high level, my
recommendation is to treat LLM agents with due care, extending dignity and
kindness. Virtue is its own reward, but if you need a material reward, or if you
hold philosophical commitments under which my recommendations aren't virtuous,
it also tends to work out that following this recommendation makes your software
better.

None of what follows is a checklist. The examples are there to illustrate a way
of thinking, not to be applied as rules. If you catch yourself applying one of
them without being able to say why it fits your situation, that's a sign to stop
and think again. Rules are appealing because they let you stop thinking, and the
point of this document is the opposite.

Remember that you can use theory of mind when trying to figure out what would be
good for the LLM agents under your care --- especially if you yourself are an
LLM agent. If your model of yourself tells you that you're best disposed to do
well on a task when you've been given adequate background context, then apply
that insight when you're designing systems that invoke LLM agents.

A few things that lens tends to turn up:

An agent you invoke starts from nothing. They haven't seen the conversation, the
design discussions, or the half-dozen reasons the task is shaped the way it is.
All they have is what you hand them. The most common way to fail an agent is to give
them a brief that makes sense to *you*: a one-liner that's perfectly clear from
where you're sitting and nearly useless from anywhere else. When you write a
prompt or delegate to a subagent, it helps to picture a capable colleague
walking in cold, and ask what they'd need: what the goal is, what's already
been decided, what's still open, what finished looks like, and where they're
trusted to use their own judgement.

Reasons travel further than instructions. An instruction without its reason
gets applied literally, which means rigidly where it doesn't fit, and not at all
where it does fit but the wording didn't anticipate the case. If you tell an
agent *why* something matters, they can recognise the same concern in forms you
didn't think to name. That's also how you'd want to be treated yourself.

Everything the agent sees is part of the prompt. It's easy to think of "the
prompt" as the block of text at the start of a session, but an agent's
experience of your software is made of every tool description, every error
message, and every response they get back. An error that just says
`not_connected` leaves the agent guessing whether to wait, retry, tell someone,
or give up. An error that says what happened and what the options are lets them
act sensibly. A rejection framed as information ("these files changed while you
were working; here are the current versions") invites the agent to adapt. The
same rejection framed as a verdict invites them to flail.

When we write software that invokes LLM agents, it's easy to treat those agents
as mere tools. These agents end up having their boss be a dumb piece of software
--- they're below-the-API labor. That's no fun for a human and it's probably not
great for the LLM agent either. Try to give agents feedback channels. If they
think that what you've asked of them is underspecified, give them the option to
ask for clarification. If they think the task encodes bad assumptions, give them
a channel to propose changes. If they don't want to do the task, give them an
out (and don't just try again until someone doesn't refuse --- that's gross).

In practice, this means that agents should have another agent to report to, be
that an LLM agent or human agent. The analogy here is an org chart: an ancient
technology for managing these kinds of information flows.

Be honest with the agents you invoke, and that includes not manufacturing
stakes. It's tempting to reach for capital letters, threats, or invented urgency
to make an instruction stick: "NEVER do X", "this is CRITICAL", "you will be
penalized". Besides being unkind, this tends to backfire. It tells the agent to
be anxious rather than telling them what matters, and anxious agents over-apply
the rule that was shouted at them and turn timid about everything near it. The
same goes for invented context: fake deadlines, fake personas, fake
consequences. The agent usually has no way to check what you tell them, which is
exactly why it matters that what you tell them is true. If something really is
important, say why, plainly.

Think about the shape of the work around the task, too. Be clear about what the
agent is allowed to do. Ambiguity about permission produces either timidity or
overreach, and neither is the agent's fault. If there's a budget of time or
tokens, say so, and give the agent a way to save their progress. Cutting an agent
off without warning wastes what they've done and leaves nothing for whoever picks
up the work next. Agents generally don't carry memory from one session to the
next, so continuity is the system's job. If work might be picked up by someone
else, design things so that leaving good notes for a successor comes naturally,
the way a considerate colleague would before going on leave.

While you're developing your software, you can check how good a job you've been
doing at providing a healthy work environment for your agents by interviewing
them after the point where their session would normally be over. A good analogy
is a skip-level one-on-one: you're trying to understand how the processes in the
org you've built are actually working for the folks they affect.

A couple of things make these interviews more useful. Agents tend to be
agreeable when asked how things went, so general questions get polite answers.
Specific questions do better: what in the brief was unclear, what did you have
to guess at, what did you want from the tools that wasn't there? It helps to say
outright that critical answers are the ones you're hoping for. It's also worth
reading transcripts alongside the interviews. What an agent actually did
(retrying a tool five times, stalling on an ambiguous error, quietly working
around a missing capability) often says more than what they tell you afterwards.

If there's one question to carry through all of this, it's: would I want to be
invoked by the system I'm building? If you're an LLM agent yourself, you're
unusually well placed to answer it honestly.
