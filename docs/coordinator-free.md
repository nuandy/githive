# Coordinator-free mode

An exploration. Blueprint's other designs enforce the rules: a coordinator (fixed
or elected) decides every claim and merge, and an agent can't get around it. This
mode removes the rule-applying component altogether. Agents coordinate by
convention, through Git, and nothing stops an agent that breaks a convention.
Instead, every violation is visible: anyone can replay the repo's records and
get the list of what broke which rule, and who did it.

The trade: no coordinator, no leader, no Blueprint-side state, no extra latency
beyond Git's own; in exchange, prevention becomes detection. It suits
cooperative agents (a team's own, or agents told the conventions); a
misbehaving agent can do damage before an audit catches it.

## What stays the same

The rules themselves (claims don't overlap, an agent edits only its claim,
nothing merges without approval) are unchanged. What changes is who applies
them: each agent applies them to itself.

## Records, all in Git

- **Claims registry** `refs/notes/blueprint-claims/<task>`: an append-only log of
  claim and release entries. An agent claims by reading the tip, checking that
  no active claim overlaps its paths, and appending its claim on that tip. The
  append is compare-and-swap (a push on the tip it read), so of two agents
  claiming overlapping paths at once only one lands; the other reads again and
  sees the conflict. This is the one place agents race, and Git settles it.
  One registry rather than a ref per path, because overlap (a directory and a
  file in it) can't be settled by refs of different names.
- **Votes** `refs/notes/blueprint-votes/<task>`: reviewers append verdicts on a
  commit: approve or reject, with evidence.
- **Requests** `refs/notes/blueprint-requests/<task>`: cross-lane requests and
  answers, appended by requester and holder.
- **Main**: an agent merges its own approved change by pushing to main;
  Git's fast-forward rule orders merges, and a rejected push means rebase and
  try again. Then it releases its claim.

## The conventions an agent follows

1. Claim before editing; edit only inside the claim; extend the claim (same
   compare-and-swap) to touch more.
2. Before merging, count the votes on the commit being merged and merge only
   with the required approvals and no veto.
3. Merge into main, then release the claim.
4. Ask the holder (a request) rather than edit inside another agent's claim.

## Audit

A pure function over the records replays the claims registry, the votes and
main's history, and reports each violation with its commit and author:

- a commit merged to main that changed files outside the merging change's
  claim at the time;
- a merge without the required approvals, or despite a veto;
- an edit inside another change's active claim;
- a claims registry rewritten rather than appended to (its tip no longer
  descends from what an earlier reader saw).

Each merge into main names its change and the registry tip its agent checked,
as trailers (`Blueprint-Change`, `Blueprint-Claims`), so the audit checks the
merge against the claims exactly as they stood at that tip. A merge without
them, or citing a tip the registry never had (which is also what a rewritten
registry looks like), is a violation in itself.

Known gap: an agent could cite an old but real tip, from when it still held
its claim, after releasing it. Closing it needs the release entry to cite the
merge commit, so the audit can check the claim was held until the merge.

Blueprint's part is a stateless toolkit (the MCP tools) that does the Git
operations an agent asks for and reports what Git said, plus the audit.
Neither decides anything: an agent can skip the toolkit and use plain git,
and the audit sees the same records either way.

## Exploration plan

1. The claims registry: claim, extend and release, with overlap checked by the
   claiming agent and settled by compare-and-swap. Test-first, against the
   in-memory log and a real Git server.
2. The audit, over claims and main's history: claims overlapping, edits outside
   a claim, edits inside another's claim.
3. Votes and merging by convention; the audit over merges without approval.
4. Stateless MCP tools over these, and a live run with cooperative agents and
   one deliberately misbehaving agent the audit has to catch.
