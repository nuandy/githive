# Coordinator-free mode

Blueprint's other designs have a coordinator (fixed or elected) that decides
every claim and merge. This mode has none. Agents coordinate through Git: claims,
votes and merges are signed records in Git, written through a stateless toolkit
that any Worker instance runs the same way. Each change is a branch in its agent's own fork,
and only the toolkit writes the project's main, after the conventions hold, so
an agent can't push around them. Anything written around the toolkit anyway (by
whoever holds the account's credentials) is visible: anyone can replay the
records and get the list of what broke which rule, and who did it.

Here main means the project's default branch, whatever its repo calls it (main, master, ...): `free_start` reads it from the repo and records it.

The trade: no coordinator, no leader, no Blueprint-side state; in exchange,
every call reads and writes its state in Git (see the benchmark).

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
   with the required approvals, every veto role's among them, and no veto.
3. Merge into main, then release the claim.
4. Ask the holder (a request) rather than edit inside another agent's claim.

## Audit

A pure function over the records replays the claims registry, the votes and
main's history, and reports each violation with its commit and author:

- a commit merged to main that changed files outside the merging change's
  claim at the time;
- a merge without the required approvals (every veto role's among them), or
  despite a veto;
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
and live on Artifacts. At first every agent could write the project repo: in
that live run, cooperative agents claimed, reviewed and merged by convention; a
rogue agent the tools refused went around them with plain git, merging inside
another agent's claim with one approval of two (its trailers claiming all was
well) and pushing a hotfix straight to main; the audit, from Git alone,
reported exactly those violations and nothing about the cooperative merge.
That led to forks (below), and that shared mode was later removed.

- **Claims work without a coordinator.** Git's compare-and-swap on one registry
  ref gives cooperative agents exclusive lanes, even when two claim at once.
- **Prevention, with forks; detection and remedy for the rest.** Each agent
  has its own fork (`free--<repo>--agent--<name>`, made on its first change),
  with a branch `changes/<change>` per change; an agent gets read access to
  the project and write access only to its own fork, so it can't
  push to main or touch the records (`scripts/free-forks-demo.mjs`: a rogue's
  push to main is refused). Whatever is written around the toolkit anyway, the
  audit reports, and any agent may revert it with `free_revert`, which refuses a commit the audit doesn't report, or
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
  doesn't count; a veto counts from anyone. Every veto role must approve
  before a merge, so a veto can't arrive too late. Merging, the audit and
  `free_status` all count this way, so an agent can't approve its own change,
  or approve twice under two names.
- **Shared mode is gone.** Letting every agent write the project repo (a
  branch per change, no forks) saved making a fork (about 9 s a change), but
  Artifacts takes one push at a time per repo: at 100 agents, 64 failed pushing
  their branches to the one repo. Agents' git clients would have to queue and
  retry, which Blueprint can't make them do; forks are the fix.
- **Merging checks what it can.** The toolkit's merge test-merges the change
  into main first (a conflict comes back as the files, and what to do), then
  runs the project's checks on main plus the change in the Gate's container
  (in line with other merges: see The line of merges), and records which main
  they passed on (`Blueprint-Tested`); the audit reports merges that don't. Live: a change deleting a file the checks need was
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

| agents | fixed Coordinator (short locks) | elected coordinator | coordinator-free, one record | sharded, in the project repo | sharded, over 8 records repos |
|---|---|---|---|---|---|
| 1 | 11.6 s | 28.2 s | 27.3 s | 35.5 s | |
| 5 | 16.1 s | 28.4 s | 43.1 s | 42.8 s | |
| 10 | 31.9 s | 48.1 s | 52.7 s | 45.9 s | |
| 25 | 71.3 s | – | 91.9 s, 2 failed | 44.3 s | |
| 50 | – | – | 140.3 s, 22 failed | 59.7 s | |
| 100 | – | – | – | 69.3 s | 73.9 s |
| 200 | – | – | – | 200.7 s, 30 failed | 61.0 s |
| 1000 | – | – | – | – | 212.8 s, 220 failed |

Sharded, with no failures up to 100 agents (606 calls at 100), exactly one
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

**Records repos.** Artifacts takes one push at a time per repo. With every
shard in the project's repo, 200 agents queued about 400 claim and release
pushes on it: releases took 37 s at the median, and 30 claims gave up after
their pushes were refused as busy again and again. Spread over 8 records repos
(by a hash of each shard), the same 200 agents ran in 61 s with none failing:
releases 6.4 s at the median, claiming with the fork 15.9 s. Run to run, times
vary by about 10 s (100 agents took 69 s once and 74 s once).

**1000 agents at once** is past what this setup holds. With every read going
to all 8 records repos, 522 of 1000 agents failed on 500s from Artifacts.
Targeted reads (each change indexes the shards it claimed in, so status,
check, credentials and release read at most two repos) and retried 5xx pushes
brought that to 220 (claims left over: 258 to 41). The rest are still the Git
servers answering 500 or 503 under about 1000 agents starting in the same
instant, mostly on claims (an index write, a shard write, and the checks
around it) and on listing every claim (still a read of all 8 repos). Exactly
one racer still won, and no two claims overlapped. Spreading the 1000 agents'
starts over 60 s didn't help (268 failed): each agent's work takes one to two
and a half minutes, so they still overlap, and the errors came from every
repo involved (records repos, the project repo, the agents' forks), which
suggests a throughput limit across Artifacts for the namespace, not one busy
repo: roughly 5,000 calls in three and a half minutes, each several Git
requests. Next steps: more records
repos, and listing claims less often (agents, not the toolkit, decide that).
Votes now shard like claims (see Sharding on demand).

Small runs pay for sharding: one agent takes 35.5 s against 27.3 s with one
record, since a read lists the shards before fetching.

## Sharding on demand

Sharding only pays when many agents write claims at once, so a repo starts
with every claim in its registry and shards when the load calls for it.
Measured on bench, 2026-10-07 (simulated agents through the toolkit, each
claiming its own folder, so all waiting is contention on the records):

| agents | one record: all claim at once | sharded: all claim at once | one record: claim/release loop | sharded: claim/release loop |
|---|---|---|---|---|
| 2 | 7.5 s | 12.5 s | 37 writes/min, p95 11 s | 23 writes/min, p95 6 s |
| 4 | 6.9 s | 9.6 s | 38/min, p95 21 s | 47/min, p95 6 s |
| 8 | 13.9 s | 8.2 s | 38/min, p95 32 s, first failures | 89/min, p95 6 s |
| 16 | 24.5 s | 10.2 s | 35/min, p95 45 s | 186/min, p95 6 s |
| 32 | 52 s | 9.4 s | 29/min, p95 56 s | 347/min, p95 6 s |
| 48 | 63 s, 17 failed | 7.3 s | 28/min, p95 68 s | 538/min, p95 6 s, none failed |

One record takes about 35 writes a minute, whatever the number of agents, and
a write there costs 1.6 s when nobody else is writing. A sharded write costs
about 5 s (an index, the shard, and the checks above it) at any load. From
8 agents claiming at once, sharded claims land first.

So `free_start` (unless told `shard_depth`: a depth to shard now, 0 never)
records `autoShard`, and a claim shards the registry first when 8 agents would
hold claims, or more than 15 claims and releases were written a minute over
the last 5 minutes (`shardingReason`). Sharding is one compare-and-swap on the
registry that sets `shardDepth` (and makes the records repos first); it
happens once.

**The registry is the shard above every other.** The claims held when it
shards stay in it and are released from it. Every shard claim checks it, as
it checks every shard above its own; a claim that lands in it after the
switch (made by a caller that read it before) checks every shard below, like
any claim covering more than its own shard. Each claim writes before it
looks, so of two overlapping claims, at least one sees the other, across the
switch too. A change with no index has claimed only in the registry.

**A claim spread over many shards is written once**, in the shard holding all
its paths (more than 4 shards: `examples/a/…` to `examples/x/…` go to
`examples`; paths with no common folder go to the registry), and checks the
shards below it. Writing it shard by shard took 70 s for 24 example folders.

A merge cites the registry as `=<tip>` among its shards; it covers every file.

**Votes shard on demand too.** Every vote is a write to the one votes record,
so a swarm reviewing at once meets the same limit. Votes stay there until 8
reviewers vote within 5 minutes, or more than 15 votes are written a minute
(`votesShardingReason`, in repos whose claims may shard); then the record is
marked sharded, once, and new votes go to one of 16 buckets by the commit's
leading hex digits, each its own ref, spread over the records repos
(`vote-store.ts`). Votes never conflict, so nothing is checked across the
switch: the votes cast before stay in the record, a vote cast there after (by
a caller that read it before) still counts, and every reader reads the record
with the buckets it needs (a commit's votes: the record and one bucket).
Questions for a person (`free_ask_human`) are rare and always stay in the
record. A merge cites its votes as `=<record tip> <bucket>=<tip>`, and the
audit counts the cited records together.

## The line of merges

Every merge must be tested on exactly the code it lands on (the audit checks
`Blueprint-Tested`). Checking merges one at a time costs a check run each, in
a row (about 90 s each on Express). Checking them side by side on one main
gains nothing: the first to land makes the others' results stale.

So merges wait in a line (`check-line.ts`), kept by the repo's Gate. Merges
ready together (within 2 s of an idle line) form a batch of up to 4, and each
is checked on main with the merges ahead of it in the batch merged in first,
all at once, each in its own container (the repo's Gate and three beside it).
A result says what it was tested on and after; the merge waits until exactly
those merges have landed on that main, then lands (`Blueprint-Tested-After`
lists their heads). A merge behind one that failed is checked again without
it, first in line; one whose merges ahead never land within 5 minutes, or
whose main went another way, checks again. Ten merges ready at once take
three batches, about three check runs, instead of ten.

The line decides nothing: it schedules check runs. Each agent's merge lands
itself, and the audit checks that exactly the listed merges came between the
main the checks ran on and the merge.

## Who can block a merge

A policy's veto roles (security, say) block a merge with a rejection and
must approve. They count only from whoever the repo's owner granted them at
`free_start` (`grants`): registered agent names (voting with their own key,
so a name can't be borrowed), people (`person:*`, or one person), a verified
identity (`service:<id>`), or Blueprint's hosted reviewers (`blueprint`).
Unlisted, a veto role is held by people and Blueprint's reviewers. A vote
under a veto role from anyone else counts as an ordinary review, and
`free_status` says so (`ungranted`). Before grants, any agent could vote as
security and satisfy it.

## Agents without roles: free_next

Users send agents; they don't design a team of builders and reviewers. An
agent that doesn't know what to do calls `free_next`, and gets the most
useful thing for it now:

1. its own change: merge it once approved, revise it when a reviewer asked
   for changes, finish it if nothing is pushed;
2. a review someone is waiting for: never its own change, nor a commit it
   voted on or one waiting on a revision. A role that can block a merge comes
   first, but only to an agent granted it (see Who can block a merge); then
   the changes with the fewest approvals, oldest first;
3. a piece of the repo's backlog nobody has taken (`free_add_work` adds to
   it; an item is taken once a change by its id is claimed, done once that
   change merges);
4. else wait, saying why.

Agents are spread over the few best choices, so they don't all take the
same one. Nothing is reserved: two agents told the same piece both claim it,
and the claim decides, since a change is only ever its first agent's (a
claim under another agent's change name is refused, in one record and in
shards). Reviews balance themselves: when they pile up, every agent is sent
to review; when they're done, every agent builds.
