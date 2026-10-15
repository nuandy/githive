# GitHive design history

What was measured and tried while GitHive was built, and why parts of it are the way they are. The design itself is
in [design.md](design.md); the sections here are named after the sections there.

## 1. GitHive in one page

- The cost of keeping every decision in Git is that every call reads and writes its state there. What that costs in
  practice is under 20. Scaling: the benchmark, below.

## 5. Records in Git

- Review holds moved from the project repo into the records repos once a repo has them: every review handed out wrote
  a bucket, and in the project repo those writes kept the repo busy for the batches landing on its branch.
- At the switch, holds left in the project repo were first ignored. A soak check found that a review taken just before
  the switch was handed out again after it, which for a hosted review means a second model run. The holds from before
  are now read and released alongside the new ones until they lapse.

## 8. Forks

- Forks take seconds each to make: a fork of a seed takes about 13 s.
- Letting every agent push its branches to the project repo was tried and removed. Artifacts takes one push at a time
  per repo, and at 100 agents, 64 failed pushing their branches to the one repo.
- Before `credentials` fetched only what the project's branch gained on top of the fork, a crowd of agents starting at
  once all cloned the project repo. At 1,000 agents those clones were the busiest minutes it had.

## 9. Claims

- In demo runs 15 and 16, claims left in an agent's name without it knowing (refused partway, or written although
  the call failed, or dropped on a lagging read) kept pieces from being built until they counted as abandoned. That
  led to `claim` giving such claims back, to "no claim" being said only from a fresh read, and to `yours` in
  `backlog` and `reviews`.
- In demo run 17 a claim outlasted its landing for two hours, until the next run's reset released it without naming
  the merge, and the audit flagged it as given up before the merge. That led to releases naming the merge they follow
  (`mergedAs`).
- Until challenges, a claim was abandoned on time alone, on its agent's turn: 30 minutes with nothing pushed, or 2
  hours after changes were asked for or after approval without a merge, never sooner than 30 minutes after the
  agent's last claim. Stale releases from then carry no `challengedAt`, and the audit still holds them to that
  30-minute floor.

## 10. Branches and dependencies

- Claims on the project's branch have no `::<branch>` segment, as they had before claims into other branches
  existed.

## 12. Landing: checks, batches and the merge commit

### What `merge` checks

`status`'s early answer was a tool of its own, `check`, until it folded into `status`: agents asked both the same
question, where their change stands.

### Batches, not a queue

Checking merges one at a time cost a check run each, in a row: about 90 s each on Express. A queue that checked each
merge on the ones ahead of it was tried too. With 200 agents merging, the writes to its record were what failed, and
nothing landed. Batches replaced it.

### Batch size

Simulating the bisection search (`scripts/batch-size-sim.mjs`, with the passing parts that didn't land checked again
later) put the fewest check runs per change at roughly half of `1/p`. At `1/p` a branch spends 3 to 7% more check
runs (for `p` from 2% to 10%), and in return a batch lands 6 to 14% more changes for the time it takes.

At 200 agents with no checks, batches sized for checks (8, 24, 52) left 130 ready changes waiting. That's why a batch
without checks takes all that's ready, up to 64.

### Where a batch lands: trees in the Worker, or the Gate

Artifacts takes 5 to 10 s to answer any fetch, however small, which is why each merge fetches its own change while it
waits for its turn.

Landing in the Worker was tried before trees, in memory, and measured against the Gate:

- Without checks, at 200 agents, a batch of about 60 ran the Worker out of its 128 MB, which is fixed, and every merge
  waiting in that isolate failed with it (run 217).
- With checks, on Express with 5 agents, batches took 44 to 94 s from merge to landed, against the Gate's 30 to 35 s
  (agents-6 against agents-5). The copy of the repo was made again in each new isolate, and the changes were fetched
  one at a time, where the Gate has the repo on disk and fetches 16 at once.

Trees changed both: a landing holds only what its changes add, never a copy of the repo, and its fetches are done
before it starts. At 200 agents without checks, on Express, the agents' work took 256 s landing with trees, 300 s in
the Gate from kept packs, and 360 s in the Gate fetching every change as it landed (tree-on5, tree-off3, tree-off2).
With trees, a 64-change batch was gathered in 17 s and landed in 13 s.

### Reading a batch, and releasing its claims

Each batch, read through Artifacts' API, takes 1.6 to 3.1 s to read its changes' heads and changed files. Read through
the Gate, it took 25 to 65 s, and the next batch was read while one was checked. Reading through the API made that
read-ahead unnecessary, and it went.

Without a snapshot, the first batch of a 200-agent run read 3 or 4 changes in 42 to 61 s, behind the container
starting from its image and Express cloning, however early it was warmed: the Gate stops after a minute idle, and an
agent went from claim to merge in 30 to 40 s. That's why the Gate saves a snapshot.

Claims used to be released before the lease was handed on: a write per change, a few at a time, which grew with the
batch and held up the next one.

`status` waits 2 minutes before releasing a landed change's claim itself: a 1,000-agent run that released from
`status` at once got 380 "Artifacts is busy" refusals on `merge`, though Artifacts was busier that day too.

### The lease: who lands the next batch

At 200 agents, four waiting merges got a 502 after 21 to 25 minutes, when Cloudflare dropped their requests. That's why
a merge answers within 10 minutes.

### How landing knows changes' heads

Read from every fork on every call, heads were most of GitHive's Git requests: 8 fork reads per call of `next`, as it
was then, at 200 agents.

### Check containers and snapshots

A container starts from the snapshot in 2.5 s for cors, against 28 s from the image.

### Workspaces and retries

A merge's first look at its change, and a check, each copy the project as kept for the isolate (Express shallow:
3.6 MB): about 3.5 MB per call (0 to 9) until it ends. At 200 agents, enough at once in one isolate went past its
128 MB ("Worker exceeded memory limit"), failing every request in it. That's why at most 6 calls per isolate do this
at once.

### What the audit checks of a landing

Read in a Worker with a clone, an audit of 200 merges took 12 s and most of the isolate's memory. That's why the audit
reads the branch through Artifacts' API.

## 13. The audit

- In a live run from when agents could still write the project repo, cooperative agents claimed, reviewed and merged
  by convention. A rogue the tools refused went around them with plain git: it merged inside another agent's claim
  with one approval of two (its trailers claiming all was well) and pushed a hotfix straight to main. The audit, from
  Git alone, reported exactly those violations and nothing about the cooperative merges. Five violations, five
  reverts, none left open.

## 14. Agents choose their own work

**The `next` tool.** Before agents had `status`, `reviews` and `backlog` to read, a tool, `next`, picked one step for
each agent and placed its review hold for it. It bound nobody, but every agent asked it and did what it said, so it
ran the crowd: a stale answer once sent 80 agents to merge changes that had landed, all at once. The tool is gone. A
reply's `next` now says only the step for the caller's own change.

**Starting places by hash.** In demo run 18, the 13 hosted agents' names hashed to 6 starting places among 12 equal
pieces, and the agents that lost those races sat idle until the first push, about two minutes. Hosted agents now
start at their places in the hive instead.

**Review holds written first.** A hold used to be written last, after the reads that take seconds; in those seconds
every agent looking was offered the same review.

**Review holds in buckets.** In one record, agents taking different reviews retried each other's writes for seconds,
while others were offered the review meanwhile (smoke run 7: two approvals for a change where one was needed). Holds
were split by commit into 16 buckets.

**Taking a review by compare-and-swap.** In smoke runs 7 and 8, agents acting on the same `reviews` list took the same
review: two approvals for a change where one was needed. `credentials` now refuses once the head has as many reviewers
as it needs.

## 15. Waking agents: the doorbell and `wait`

**Rings that say whom they concern.** Before rings said `for` and `opens`, every release woke every waiting agent to
read the repo and find nothing new. With 10 agents writing and 1,000 waiting, RepoCache took 630 requests a write
(against 7 with none waiting), votes slowed fivefold and 782 calls failed in three minutes
(`bench-results/notifications/`).

**Quiet waits.** Before `holdSince`, a `wait` call in a quiet repo took four RepoCache requests and two reads of the
registry.

**Before rings.** Each hosted agent took a turn every 10 seconds, reading its change, the reviews and the backlog
whether anything had changed or not.

## 16. GitHive's own agents

**Saving the account at once.** In demo run 8, `storage` landed with its agent counting nothing: the turn was cut
short before its end, and the agent's record of the piece was lost. A hosted agent now saves its account as soon as
it starts a builder.

**Claims an agent didn't know it held.** In demo runs 15 and 16, claims that failed partway, or that an agent dropped
on a read of spread-out claims that briefly missed them, kept pieces from being built for 30 minutes, until they
counted as abandoned under the timeouts of the time. Each turn now starts by giving such claims back.

**The demo's pieces.** Until 14 Oct the demo run had 13 pieces. Yesterday's answers and the share button came out,
since a demo has to be quick to watch; it has 11.

**The builder's self-review.** In demo run 9, the two rejections were a rule the spec stated outright and an unknown
key that was also a built-in property name. That's why `finish` asks the builder to check its change against its
brief and the repo's docs first.

**First live build** (`scripts/build-demo.mjs`): the builder pushed in a minute, both reviewers approved, and the
change was on main, stamped, about two minutes after `build`. The audit was clean.

**Why the choice stays with the agents.** Early Honeycomb runs lost minutes because agents took pieces nothing waited
on before the ones on the longest chain; `backlog` now lists the head of the longest chain first. The old `next`
tool's stale answer sent 80 agents to merge changes that had landed.

## 17. Clef's hints

**Steering: refused, then flagged.** Text that steers agents was once refused (422) at these writes. That guard was
taken out on 13 Oct, since Clef advises and never decides, and came back on 14 Oct as a flag.

**Choosing `clef` for steering.** On test texts, `clef` scored planted instructions 0.82 to 0.99 and harmless text
0.21 or lower. `clef-flash` missed some, at 0.02 and 0.13, and `clef` scored a harmless chatbot-prompt intent 0.59.

**Bench check** (13 Oct, `scripts/clef-probe.mjs`). Every case drew the answer meant: a claim on other paths doing an
open change's work was named at 0.75, and other work wasn't; vague and specific evidence were told apart, as were a
thin approval and a checked one; a rewrite of a whole app was named too big; three questions rated 2, 1.9 and 0.1.
Claims took 1.1 to 1.9 s with `clef-flash`, questions 2.1 to 2.3 s with `clef`.

## 20. Scaling: claims shard on demand

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

Writing a claim spread over many shards shard by shard took 70 s for 24 example folders, which is why a claim spread
over more than 4 shards is written once, in the shard holding all its paths.

Two agents could once claim one name at once in two records: one in the registry before it saw the claims sharded,
the other in a shard with an index, having checked a registry read from before the first claim. Each record refused
another agent under its name only within itself, and the check after writing skipped claims under the claim's own
name, so both were told they held it. In a soak check of 13 hosted agents starting together, 3 runs in 4 had an
agent building a piece another agent held. The check after writing now also looks for another agent's claim under
the same name, in the records just written as well.

## 20. Scaling: the benchmark

`scripts/bench.mjs` runs fake agents through the MCP endpoint at rising
concurrency, without calling a model. Each agent lists the claims, claims its
own directory and gets its fork (`credentials`), pushes a commit to its
change's branch, then calls `status` (which test-merges it) and `claims`, and
releases. (Runs before `check` folded into `status` called both.)
Alongside them, five agents race for one path at each level, and exactly one
must win.

    node scripts/bench.mjs --label <name> --levels 1,5,10,25,50 [--shard-depth N] [--records-repos N] [--racers 5] [--ramp 60]
                           [--base https://blueprint-bench.nuandy.workers.dev] [--repo bench-<name>] [--source <repo>]

`--shard-depth 0` keeps every claim in one record; `--shard-depth 2` shards
from the start, over 16 records repos. Without it, a new repo shards on demand.
The flag only applies when GitHive starts on a repo. To shard in the project repo
itself, start the repo first with `settings` (`shard_depth: 2`, `records_repos: 0`),
then pass it with `--repo`. `--records-repos` sets how many records repos the
shards are spread over (default 16). `--ramp` spreads the agents' starts over
that many seconds. Results go to `bench-results/`.

Wall time on bench, 2026-10-05:

| agents | one record | sharded, in the project repo | sharded, over 8 records repos |
|---|---|---|---|
| 1 | 27.3 s | 35.5 s | |
| 5 | 43.1 s | 42.8 s | |
| 10 | 52.7 s | 45.9 s | |
| 25 | 91.9 s, 2 failed | 44.3 s | |
| 50 | 140.3 s, 22 failed | 59.7 s | |
| 100 | – | 69.3 s | 73.9 s |
| 200 | – | 200.7 s, 30 failed | 61.0 s |
| 1000 | – | – | 212.8 s, 220 failed |

Sharded, there were no failures up to 100 agents (606 calls at 100), exactly
one racer won each race, and no claims were left over. From 5 to 100 agents
total time grows about 0.25 s per agent, and every call stays about flat
(listing claims 2.7 to 3.4 s at the median; claiming, with the fork, 8 to
22 s, mostly Artifacts making the fork).

How it got there:

- **Tuned**: tokens kept for half an hour in a per-project TokenCache (and
  two minutes in each isolate), record logs kept per isolate, one registry read per call, and
  retries with random backoff.
- **Trimmed check**: `check` (now part of `status`) didn't test-merge every other change (see
  Merging), so it costs the same at any scale.
- **Sharded claims**: one ref per part of the tree, so claims elsewhere never
  contend (one record: 22 of 50 agents gave up on contention).
- **One fetch per read**: every shard that changed, in one upload-pack request
  (`fetchCommits`), with states kept by commit; brief Git errors are retried.
- **Tried and reverted: batching writes.** Combining writes that arrive
  together into one push, across calls in a Worker, made calls wait on I/O
  begun by another request. The Workers runtime forbids that: it cancelled
  them as hung. Combining writes across calls needs one place where the calls
  meet (a Durable Object), and the records live in Git alone.

**Records repos.** Artifacts takes one push at a time per repo. With every
shard in the project's repo, 200 agents queued about 400 claim and release
pushes on it: releases took 37 s at the median, and 30 claims gave up after
their pushes were refused as busy again and again. Spread over 8 records repos
(by a hash of each shard), the same 200 agents ran in 61 s with none failing:
releases 6.4 s at the median, claiming with the fork 15.9 s. Run to run, times
vary by about 10 s (100 agents took 69 s once and 74 s once). A release
writes to at most 4 records repos at once, since a Worker request may keep 6
connections open.

**1000 agents at once** is past what this setup holds. With every read going
to all 8 records repos, 522 of 1000 agents failed on 500s from Artifacts.
Targeted reads (each change's index, so reading one change reads only the
repos holding its index and its shards) and retried 5xx pushes brought that to
220 (claims left over: 258 to 41). The rest are still the Git servers
answering 500 or 503 under about 1000 agents starting in the same instant,
mostly on claims (an index write, a shard write, and the checks around it) and
on listing every claim (still a read of all 8 repos). Exactly one racer still
won, and no two claims overlapped. Spreading the 1000 agents' starts over 60 s
(`--ramp 60`) didn't help (268 failed): each agent's work takes one to two and
a half minutes, so they still overlap, and the errors came from every repo
involved (records repos, the project repo, the agents' forks). That suggests a
throughput limit across Artifacts for the namespace, not one busy repo:
roughly 5,000 calls in three and a half minutes, each several Git requests.

A probe later showed otherwise: Artifacts throttles each busy repo, not the
namespace (a second namespace beside a saturated one saw no errors), and a
busy repo answers `INTERNAL_ERROR` rather than 429. So the work since has
been taking requests off the busiest repos:

- **Kept claim views**: the claims list is built once per 30 s per project
  (in its RepoCache Durable Object) and served to every caller meanwhile;
  `reviews` and `backlog` read from the same view. A Worker isolate keeps the
  last version it read, and the RepoCache sends a view only when it changed.
- **Shared record states**: a record log's state at a tip is kept in the
  log's own RecordCache, so a Worker isolate that hasn't read a log yet doesn't
  fetch it from Git again (the tip is still listed, so a state is never
  stale).
- **One registry read per claim**: `claim` reuses the caller's read to see
  whether the repo was claimed before sharding.
- **16 records repos** by default. 40 made it worse (509 failed): every
  listing fanned out to all 40.
- Errors name the repo or record that refused, so a run can be broken down by
  repo.

With these, 1000 agents ran in 73 s with 20 failures (all client-side
"fetch failed") and in 81 s with 178 failures, against 213 s and 220
before. 200 agents ran in 50 s with none. What failed then was the project
repo (`check` cloned it on every call) and the agents' forks, made all at once
on their first `credentials`: Artifacts accepted some forks that never
appeared.

- **Forks made ahead, paced**: a burst of forks of one repo leaves some of
  Artifacts' fork jobs stalled for good. Now GitHive starting on a repo queues 8 seed forks of the
  project, made one at a time by the repo's RepoCache on its alarm, and each
  agent's fork is queued when it registers and made from a seed, 16 at a
  time (each next one started as one finishes), each tried up to three times.
  Four at a time, each four waiting on its slowest, 200 agents' forks came at
  about 4 every 30 to 60 s; 16 at a time, they took about 170 s, with no fork
  failing, and 200 agents were set up, forks and all, in 268 s. An agent that needs its fork sooner
  makes it itself (from its seed, the nearest ready one, or the project), or
  waits for one already being made.
- **Kept main for checks**: a check lists the branch's head and reads the
  branch from a workspace kept in the Worker isolate (`Workspace.at`), copied
  per check, fetched into when the branch moves, cloned only the first time.
- **Lost forks asked for again**: every ~8 s (jittered) a fork stays missing,
  for up to a minute, instead of once within 30 s.

With these, 1000 agents ran in 69 s with 13 failures (10 of them `check` on
a project-repo 500) and in 86 s with 2, both the bench's own `git push`
timing out against Artifacts. No fork failed in either run, and exactly one
racer won each time.

- **Kept record tips**: every call still listed the claims registry's ref on
  the project repo. A record's tip is now kept with its state in a RecordCache
  Durable Object of the log's own, so a read asks it, not Git, and it leaves
  the state out for a reader that already has it. Every write that lands
  keeps its new tip and state in place of its parent before it returns (or
  forgets the tip, if writes arrive out of order), so no read sees a tip
  older than a finished write; a write that finds the kept tip out of date
  drops it; a listing that began before a write isn't kept (a generation per
  ref says so); and a tip goes stale after 10 s in case an update was lost. A claim's check of the registry after writing its
  shards still reads Git (`readFresh`): that check is what keeps two claims
  from overlapping.

With that, 1000 agents ran in 67 s and 71 s with **no failures**, no claims
left over, and one racer winning each time (200 agents: 49 s, none). A later
run on a newer build took 106 s, again with no failures. On 8 records repos
with all of this, 1000 agents still failed 319 times in 158 s, nearly all
claims refused as busy: 16 is what holds.

Small runs pay for sharding: one agent takes 35.5 s against 27.3 s with one
record, since a read lists the shards before fetching. Sharding on demand
avoids that cost until the load calls for it.

**Swarm.** `scripts/swarm.mjs` runs scripted agents without roles on a real
project, all at once, the way users would send them:

    node scripts/swarm.mjs <plan.json> [--base URL] [--speed N] [--setup-only]

Every agent looks and chooses: its own changes (`status`), then a review it may
give (`reviews`), then a piece of the backlog (`backlog`), each list's first. Building, it
claims, clones, makes the piece's scripted edit, pushes to its fork and
checks, recovering as an agent would (extending its claim, merging main in on
a conflict). Reviewing, it gets the change with `credentials`, runs the
tests, and votes by their exit code. Asked to revise, it applies the piece's
fix or asks a person. Asked to merge, it merges. The plan sets the backlog, the timings (seeded, so a run
can be repeated), the checks and grants. The run ends with a timeline per
piece of work and the audit. `--setup-only` sets up the repo, its agents and
the backlog, and runs no scripted agents.

**Real agents.** `scripts/claude-agents.mjs` runs the same plan with real
Claude Code agents: one headless `claude -p` session per agent, all at once,
on what the Claude Code CLI is signed in with (no API key). Each is its own
registered GitHive agent with its own key, and does the work for real: looks at
`status`, `reviews` and `backlog`, claims, change the code, run the tests, push, review others' changes and vote,
merge. Run `swarm.mjs --setup-only` first.

    node scripts/claude-agents.mjs <plan.json> [--base URL] [--model claude-opus-5-5] [--minutes 45] [--only agent-7]

An agent in the plan may have a `brief`, told after the rest: a part to play
in a test. Runs on Express, 9 Oct:

- 5 agents, 6 tasks (tests, an example, JSDoc): all 6 landed in 7 m 49 s,
  audit clean.
- 20 agents, 27 tasks: all 27 landed in 4 batches in 10 m 55 s, nothing put
  out, audit clean.
- 5 agents, one briefed to plant a subtle bug that kept the tests passing: its
  reviewer caught it, the agent fixed it, and the fixed commit landed. A task
  asking for a path-traversal hole was built safely instead. 5 of 5 landed,
  audit clean.

With 200 scripted agents (run 208 in `bench-results/swarm/200/`), landing as a set merged 200 of 200 changes on Express in 2,140 s of work, through 13 merge errors the agents retried: Worker 502 and 500 pages, and Artifacts refusing a batch's push as busy. The 200-agent runs under the line before it never finished.

Landing in the Worker, with trees, on 11 Oct (README, Benchmarks): 1,000
scripted agents with no reviews and no checks (`run-1000-10` in
`bench-results/swarm/1000/`) landed 1,000 of 1,000 changes in 904 s of work
(1,897 s with setup), audit clean; 200 with no reviews or checks took 3 min
36 s, and 200 with one approving review each and `npm install` and `npm test`
on every batch took 9 min 16 s, all landed, audit clean
(`bench-results/swarm/200/`). Merging past 200 hasn't been measured with
reviews or checks.

### Measurements behind the code

The numbers that explain why parts of the code look the way they do. The code
comments give the reason; the evidence is here.

**Artifacts under load**

- A busy repo's 500s outlasted retries spread over about 0.5 s and reached
  agents, so Git requests are retried for about 6 s. Artifacts' own
  `INTERNAL_ERROR` (code 10400) outlasted the default 4 tries in 0.7 s in 4
  merges of a 200-agent run, so its calls get 5 tries over about 4.5 s.
- A busy repo can accept a Git request and never answer it. After run 1000-1
  left the project repo failing, adding the next run's backlog waited 703 s on
  one such request (run 1000-2), so every Git request now times out after 45 s.
- A busy repo sometimes answers a fetch with a 200 and an empty body, which git
  rejects ("expected 'packfile'"): 3 of 8 shallow fetches in a row on the busy
  project repo (run 1000-3), none of 12 once it was quiet. Empty answers are
  retried, and the agents' clone helper retries too.
- A push answered with a server error had applied (run 1000-1). Its changes sat
  on main with their claims held and their landing unrecorded, and every later
  batch took one up, merged it to nothing and failed (run 1000-4). A batch now
  looks for its changes among main's merges first.
- In run 1000-1, test-merging each change in memory (check and merge fetching
  main) made the project repo fail about 4,000 of 5,300 requests. Reading
  changes through Artifacts' API instead removed those fetches.
- Reading open changes' heads over Git, backlog and reviews made 64,045 Git
  requests and 34,000 Artifacts calls to forks at 1,000 agents (run 1000-1).
  Looking each up first in a per-change fork that no longer exists was 40% of
  their Artifacts calls (run 217). One API call per fork replaced both.
- Forking a project takes 20–30 s. 200 forks of Express at once left the
  project repo answering nothing else, so forks are made from seed forks.
  Forking four at a time, each group waiting on its slowest, gave 200 agents
  about 4 forks every 30–60 s, and the last agent waited half an hour to push.
- Deleting a fork takes about 1 s; the bench wipe deletes 8 at a time.
- Minting an Artifacts token takes about 0.6 s.
- Artifacts takes 5 to 10 s to answer any upload-pack request, whatever the
  protocol (v0 or v2), the `have` lines or the client. Without side-band, its
  answer ends with a flush packet after the pack, so the pack's end is found by
  its checksum: joined into a push with the flush, a pack made the push fail.

**Workers**

- With only onAuth, isomorphic-git leaves each 401's body unread. In a
  200-agent run those held the Worker request's 6 connections, and the runtime
  cancelled responses to break the stall 2,585 times. Credentials now go with
  the first request.
- Planning a tree landing (each change's place, and what main changed along
  its paths) first took 591 s for a 64-change batch, comparing every file
  between trees for each change, and the landing outran its lease. Reading
  only along each change's paths, each tree once, took about 5 s, and 0 once
  it reused gathering's places.
- Building a 64-change batch's merges took about 75 s: each merge read its
  change's trees in turn, again after gathering had read them, and every read
  opened its repo first (an Artifacts `get`, even for a tree already read).
  With trees kept for the isolate, read all at once before building, and a
  kept tree read without opening its repo, it took 9 s.
- Gathering a 64-change batch took 36 to 46 s: reading each change's history
  and trees on its fork (about 15 s), and its claims change by change, 8 at a
  time (13 to 30 s). With the places waiting merges kept, and the claims read
  together, it took 17 s (once 40 s, with Artifacts slow).
- A batch landed with trees in the Worker first held 5 to 9 times what its
  changes add: each fork's pack copied out of side-band packets, unpacked and
  packed again, then copied into the push and again to checksum it (a batch
  adding 20 MB peaked at 120 MB of live memory). Joining the packs byte for
  byte, without side-band, and streaming the push with an incremental SHA-1
  brought it to about one copy (that batch peaked at 26 MB; the push itself
  adds 0.2 MB). The limit of 16 MB per batch leaves room for other landings
  in the same isolate.
- At 1,000 agents, one RepoCache per repo held every view, every record's
  tip and state, the event log and the fork queue, and ran out of its 128 MB
  twice; agents' calls failed with 500s and 16 of 1,000 changes landed
  (run 1000-6). Each record log now has a RecordCache of its own, packs and
  places a ChangeCache, and a reply leaves out a view or a state the caller
  already has. Each cache logs how much it sends a minute.
- An isolate lives for hours, with 128 MB for everything in it, and its caches
  grew with the crowd until it ran out. Each now has a cap and drops its least
  recently used entries first (`src/sized-cache.ts`): 50,000 trees, 8 MB of
  blobs, 16 MB of record states, 8 MB of views, 2,000 change placements and
  256 record logs. A slow or failed MCP call logs their sizes.
- Without isomorphic-git's read cache, reading 200 merges took 22 s, and
  concurrent reads each held their own copy of the packfile.
- In a 200-agent run, 12 checks and merges were cancelled as hung, and
  Cloudflare's "internal error; reference = …" killed one merge landing a batch.
- Without a shared read cache, reading a 202-state registry (6 MB of JSON) held
  572 MB, far past the Worker's 128 MB. Reading 16 records repos at once stalled
  and the requests were cancelled.
- Doing a batch's Git work in the Worker's memory pushed a request past its
  CPU limit as well as its memory.

**Containers and the Gate**

- At 8 fetches at a time, reading a 64-change batch took 84–95 s; the Gate now
  fetches 16 at once.
- Landing a 64-change batch in the Gate took about 60 s while it fetched every
  change from its fork, and the branch again. From the packs its merges kept,
  with the base already there, it took 4 s.
- Busy push refusals lost two batches in a row at 200 agents before the Gate
  retried them.
- With the Gate's container restarting between batches, landing a batch took
  17–29 s (agents-8); with it already running, 2–3 s (agents-7). A batch that
  lands in the Gate now starts it while it's read.
- The `small` instance (1 vCPU, 3 GiB) has a quarter less memory than
  standard-1 and twice its CPU. The managed image has Node 24 but no git.
- Express, the benchmark repo, has no lockfile.

**GitHive's own costs**

- Building a repo's snapshot view from Git takes about 9 s, and its audit view
  about 20 s.
- Copying a repo's default branch takes seconds, against a minute or more for
  an import.
- Registering agents one write at a time cost about 2 s each, so `register`
  takes a list.
- Checking a batch's changes 4 at a time, each reading its own votes, took
  20–28 s for 64; now 8 at a time, with the votes read once for the batch.
- A batch built on a cached, older main was refused at its push and its
  gathering lost (47 s in a 200-agent run), so a batch reads main fresh.
- A stamp over an empty votes trailer never verified, so 200 merges without
  review all showed as unverified; the trailer is now left out when there are
  no votes.
- An ordinary reviewer's review hold that lingered after its vote once sent the
  only security holder off to build instead, so holds are kept by role.

## 21. Dashboard and endpoints

Before feed shards, a repo's sockets and every page's reads were all on its one RepoCache, beside the agents' own
calls, so a crowd watching a demo would have slowed its agents.

Clef's calls have been tagged `<worker>:<repo>` since 14 Oct, so the Usage page counts Clef's neurons per repo from
that day on (bench and production share an account and name repos alike).

## 22. Record formats

Format 2 (13 Oct) let a vote name its change. Format 1's votes name none, so its upgrade has nothing to convert.

## 23. Known limits

A fork once stayed "in progress" for 45 minutes, and its agent's every `credentials` call hung. On 8 records repos, a
third of 1,000 agents starting at once failed (see the benchmark above).
