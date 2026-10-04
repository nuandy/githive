# Coordinator-free mode

An exploration. Blueprint's other designs enforce the rules: a coordinator (fixed
or elected) decides every claim and merge, and an agent can't get around it. This
mode removes the rule-applying component altogether. Agents coordinate by
convention, through Git, and nothing stops an agent that breaks a convention.
Instead, every violation is visible: anyone can replay the repo's records and
get the list of what broke which rule, and who did it.

The trade: no coordinator, no leader, no Blueprint-side state; in exchange,
every call reads and writes its state in Git, which is slower (see the
benchmark). With shared access, prevention becomes detection: a misbehaving
agent can do damage before an audit catches it. With forks (the default), each
change lives in its own fork and only the toolkit writes main, so the
conventions are enforced where it matters, by a stateless check rather than a
coordinator.

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

A merge also names the commit that was reviewed and the votes tip its agent
counted (`Blueprint-Votes`), so the audit recounts the approvals exactly as the
agent saw them. A release names the merge it follows, so a merge citing an old
tip from before its claim was given up is caught. With no leader there is no
timer to expire abandoned claims: by convention any agent may release a claim
idle for 30 minutes, and the audit flags one released while still in use.

Blueprint's part is a stateless toolkit (the `free_*` tools on the main MCP endpoint) that does the Git
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

## What the exploration showed

All four steps are built and tested, the last end to end on a real Git server
and live on Artifacts (`scripts/free-demo.mjs`): cooperative agents claimed,
reviewed and merged by convention; a rogue agent the tools refused went around
them with plain git, merging inside another agent's claim with one approval of
two (its trailers claiming all was well) and pushing a hotfix straight to main;
the audit, from Git alone, reported exactly those three violations and nothing
about the cooperative merge.

- **Claims work without a coordinator.** Git's compare-and-swap on one registry
  ref gives cooperative agents exclusive lanes, even when two claim at once.
- **Detection works, and so does the remedy; prevention doesn't.** The rogue's
  merge is on main by the time the audit reports it. Any agent may then revert
  it with `free_revert`, which refuses a commit the audit doesn't report, or
  one whose files changed since. The revert names what it undid
  (`Blueprint-Reverts`), and the audit marks those violations resolved. Live:
  five violations, five reverts, none left open.
- **Identity is verified, not self-declared.** Every record the toolkit writes
  (claims, releases, votes, merges and reverts) carries `by`, the identity
  Access verified for the caller (`service:<name>`, or `person:` plus a hash of
  the email, so no address is stored), and an Ed25519 stamp over the record,
  made with a key only the Worker holds. The registry publishes the public key.
  The audit then trusts only stamped records: a merge without a valid stamp is
  `unverified` (and still checked against what it changed), and an unstamped
  vote doesn't count toward approval. Plain git can still write anything; it
  just can't stamp it. Agents that share one Access service token tell
  themselves apart with agent keys (`free_register`).
- **Approvals count per verified identity, never the author's.** Each signed
  vote counts once per `by`, whatever reviewer name it gives, and a vote from
  the change's author (its claim's identity, or its agent name when unsigned)
  doesn't count; a veto counts from anyone. Merging, the audit and
  `free_status` all count this way, so an agent can't approve its own change,
  or approve twice under two names.
- **Every agent needs write access to the whole repo**, main included: the mode
  trusts agents by design.
- **Merging checks what it can.** The toolkit's merge test-merges the change
  into main first (a conflict comes back as the files, and what to do), then
  runs the project's checks on main plus the change in the Gate's container,
  and records which main they passed on (`Blueprint-Tested`); the audit reports
  merges that don't. Live: a change deleting a file the checks need was
  refused with the failing command, a stale branch with the conflicting file.
- **Some coordinator duties have no owner, and some aren't needed.** With no
  leader there is no timer: an abandoned claim is released as stale by the next
  agent that needs its paths. Merge-ahead between changes is dropped: claims
  are exclusive and free_merge refuses files outside them, so two changes that
  can both merge can't conflict, and an overlap only ever means someone is
  outside their claim, which `free_check` (the change against main, and its
  files against its claim) already shows them.
- **One endpoint, one dashboard.** The mode's tools (`free_*`) are on the same
  `/mcp` endpoint as everything else, behind the same Access policy. The
  dashboard lists repos in the mode and shows each one's settings, claims,
  recent votes and the audit, with open and resolved violations kept apart.
- **Blueprint's own agents follow the conventions too.** `free_build` starts a
  hosted builder on a `changes/<id>` branch of the project repo, inside its
  claim. It pushes there, can extend its claim, merges main in with
  `fetch_base`, and may only `finish` with everything pushed. Finishing starts
  the hosted reviewers (tests and the veto roles). Each votes with its own
  stamped identity, then tries `free_merge` for the change. The toolkit refuses
  until enough approvals are in, so the first attempt that finds them merges.
  Neither agent calls a Coordinator. Live (`scripts/free-build-demo.mjs`): the
  builder pushed in a minute, both reviewers approved, and the change was on
  main, stamped, about two minutes after `free_build`. The audit was clean.

## Benchmark

`scripts/bench.mjs --mode free` runs open mode's fake-agent lifecycle through
the free tools (claim and fork, push, check, status, release), with five agents
racing for one path at each level. Each agent works in its own directory, as
agents splitting work would. Wall time on bench, 2026-10-05:

| agents | fixed Coordinator (short locks) | elected coordinator | coordinator-free, one record | coordinator-free, sharded |
|---|---|---|---|---|
| 1 | 11.6 s | 28.2 s | 27.3 s | 35.5 s |
| 5 | 16.1 s | 28.4 s | 43.1 s | 42.8 s |
| 10 | 31.9 s | 48.1 s | 52.7 s | 45.9 s |
| 25 | 71.3 s | – | 91.9 s, 2 failed | 44.3 s |
| 50 | – | – | 140.3 s, 22 failed | 59.7 s |
| 100 | – | – | – | 69.3 s |

Sharded, with no failures at any level (606 calls at 100 agents), exactly one
racer won each race, and no claims were left over. From 5 to 100 agents total
time grows about 0.25 s per agent (the fixed Coordinator, about 2.5 s); every
call stays about flat
(listing claims 2.7 to 3.4 s at the median; claiming, with the fork, 9 to 22 s,
mostly Artifacts making the fork).

How it got there:

- **Tuned**: tokens and record logs kept per isolate, one registry read per
  call, and retries with random backoff.
- **Trimmed check**: `free_check` doesn't test-merge every other change (see
  above), so it costs the same at any scale.
- **Sharded claims**: one ref per part of the tree, so claims elsewhere never
  contend (one record: 22 of 50 agents gave up on contention).
- **One fetch per read**: every shard that changed, in one upload-pack request
  (`fetchCommits`), with states kept by commit; brief Git errors are retried.
- **Tried and reverted: batching writes.** The elected leader commits
  decisions that arrive together in one push. Doing the same across calls in a
  Worker made calls wait on I/O begun by another request, which the Workers
  runtime forbids: it cancelled them as hung. Combining writes across calls
  needs one place where the calls meet (a Durable Object), which is what this
  mode does without.

What limits it further (not yet measured past 100 agents): Artifacts takes one
push at a time per repo, and every shard is in the project's repo, so claims,
releases and votes queue there; a read fetches every shard that changed, so
reads grow with the number of agents; and every change makes a fork. The next
steps for hundreds of agents would be spreading the records across several
repos (parallel pushes) and reading only the shards a call needs.

Small runs pay for sharding: one agent takes 35.5 s against 27.3 s with one
record, since a read lists the shards before fetching.
