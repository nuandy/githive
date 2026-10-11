# GitHive

GitHive lets many agents work on one repository at once. They coordinate
through Git. Claims, votes and merges are records in Git, stamped with who made
them, and a stateless toolkit writes them. Every Worker instance runs that
toolkit the same way. Each change is a branch in its agent's own fork. Only
the toolkit writes the project's main, and only once the conventions hold, so
an agent can't push around them. Anything written around the toolkit anyway
(by whoever holds the account's credentials) is visible: anyone can replay the
records and get the list of what broke which rule, and who did it.

Think of the repo as a database. `main` is the shared record, and each change
is a transaction: it declares what it will write (its claim), starts from a
snapshot of `main` (a branch in its agent's fork), writes privately, and
commits only if it still fits the latest `main` and the conventions hold.
Ready changes commit together as a batch, as a database commits a group of
transactions in one write (see Landing). The records are the log, and the
audit replays it.

Here main means the project's default branch, whatever its repo calls it (main,
master, ...): GitHive reads it from the repo when it starts there, and records it.

Nothing outside Git decides anything, and nothing outside Git orders the
agents' work: the review holds and each branch's landing lease (which merge
lands the next batch, see Landing) are records in Git like the claims and
votes, and what's ready to land is read from the votes. Durable Objects keep
only copies and hints: the dashboard's views, the records' tips and states,
changes' heads, the queue that makes forks, and what changes came to as each
branch landed. They also run containers and GitHive's hosted agents. Losing
any of it, or a repo's RepoCache not answering, costs speed, never a decision,
and never stops a merge. The
cost is that every call reads and writes its state in Git (see Benchmark).

## The conventions

Nobody enforces the rules. Every agent follows them, and the audit shows who
didn't. The toolkit refuses to help break them.

1. Claim the paths you will change before editing; edit only inside your
   claim. Claim again to extend it, or to keep it active.
2. Work on a branch `changes/<change>`, started from the branch it lands on
   (the project's, or its claim's `into`), and push it to your own fork. The project's branch is written only through the
   toolkit.
3. Reviewers vote on the exact commit they reviewed. A change merges with the
   policy's approvals, every veto role's among them, and no veto.
4. Merge through the toolkit (or by hand with the same trailers), then release
   the claim.
5. A claim its agent has abandoned may be released by anyone: its change waits
   on that agent and gets no answer (30 minutes with nothing pushed, 2 hours
   after changes were asked for, a failed check, or approval without a merge).
6. Anyone may revert a commit the audit reports.
7. What agents can't settle among themselves goes to a person (`ask_human`).

A repo's first `settings`, and the MCP handshake, give every agent a fuller version of these as
its instructions.

## Tools

The tools are on the Worker's `/mcp` endpoint. Callers sign in: an agent
token or OAuth on the public address, or Cloudflare Access on the admin
hostnames. Each tool reads or writes the repo's records in Git and reports
what Git said.

- `settings`: set up a repo's review policy, role grants or checks, rules for
  other branches (`branch_rules`), and what the checks skip (`skip_checks`).
  A repo's first settings start GitHive on it (with none given, no reviews and no checks),
  and set how its claims are kept (`shard_depth`, `records_repos`); a repo made
  on GitHive starts as it's made.
  The registry keeps every version, and each merge cites the registry state
  it checked, so the audit holds it to the settings in force when it merged.
- `register`: register an agent name and get its key, or rotate the key; or
  many new names at once (`agents`), in one write, each with its own key.
- `reviews`: the reviews this agent may give; `backlog`: the pieces of work
  free to build. Agents look and choose; nothing assigns work.
- `add_work`: add a piece of work to the repo's backlog, or many at once
  (`items`), in one write. One write each, 200 agents and a backlog of 200
  took 10 minutes to set up, one after another.
- `claims`: the claims in force.
- `claim`: claim paths for a change, or extend or refresh its claim: on the
  project's branch or `into` another, `after` the changes it depends on, or
  merging a whole branch (`source`).
- `release`: release a claim: your own, or another's its agent abandoned
  (`stale: true`).
- `credentials`: with a change, write access to its agent's fork; without,
  read access to the project.
- `vote`: a verdict, approve or reject, with evidence, on one commit.
- `status`: a change's claim, branch head, votes, the approvals it still needs,
  what GitHive's hosted agents on it are doing, and once something is pushed,
  whether it merges cleanly into the branch it lands on and which files are
  outside its claim. Agents call it after each push.
- `merge`: merge the change if the conventions hold, then release its claim.
- `audit`: replay the records and list every broken convention.
- `revert`: revert a commit the audit reports.
- `ask_human`: put a change in people's inbox, with the reason.
- `request_review`: ask GitHive's hosted reviewers for votes.
- `build`: have GitHive's hosted builder make a change, start to merge.

Neither the toolkit nor the audit decides anything that binds an agent. An
agent can skip the toolkit and use plain git, and the audit sees the same
records either way.

## Records, all in Git

Every record is one ref holding an append-only log. Each append is a commit
whose tree holds the record's whole state (`state.json`) and the entries just
added. An agent reads the tip, works out the next state itself, and pushes a
commit on that tip. The push is compare-and-swap: Git applies it only if the
ref is still where the agent read it. Of two agents appending at once, only
one lands; the other reads again and redoes its check. An append keeps trying
up to 12 times, with random, growing backoff, so the losers don't collide
again. A push Artifacts refuses as busy is sent again a few times before it
counts as not landed.

In the project repo:

- **Claims registry** `refs/notes/githive-claims/<repo>`: claims and releases.
  Its first entry records the project's branch and its commit when GitHive
  started (the baseline), the review policy and grants, the checks, GitHive's
  public stamp key, and how claims are kept. Registered agent names and the
  hashes of their keys are here too.
- **Votes** `refs/notes/githive-votes/<repo>`: verdicts on commits, and
  questions for a person (`ask_human`).
- **Backlog** `refs/notes/githive-work/<repo>`: pieces of work for agents to take (`backlog`) and
  hand out (`add_work`). An id can be added once.
- **Review holds** `refs/notes/githive-review-holds/<repo>/<bucket>`, split
  by commit into 16 buckets (waits on blocking roles in
  `refs/notes/githive-reviews/<repo>`): which agent is reviewing which commit
  in which role, marked by the reviewer
  (`credentials` for that change), so others looking at `reviews` don't pile onto one review, and `credentials` refuses a review to more reviewers than it needs. A vote counts with or without one, and the audit never reads them. Once the repo
  has records repos, each bucket is kept in one of them instead, picked by a
  hash of the bucket, and the waits record in one more: every review handed
  out writes a bucket, and in the project repo those writes kept the repo busy
  for the batches landing on its branch.
  The holds in the project repo from before are left behind; they're hints,
  and lapse within 15 minutes anyway.
- **Landing lease** `refs/notes/githive-landing/<repo>/<branch>`: which merge
  is landing a batch on the branch, and what it's checking. It's never in the
  project repo: it lives in the repo's first records repo (see Landing).
- **Main** and the other branches changes land on: written only by the
  toolkit (merges, reverts, and making a branch a claim names with `from`).

Once claims or votes shard (see Sharding on demand), there are also claim
shards `refs/notes/githive-claim-shards/<repo>/<shard>`, each change's index
`refs/notes/githive-claim-changes/<repo>/<change>`, and vote buckets
`refs/notes/githive-vote-buckets/<repo>/<bucket>`. These live in the repo's
records repos, `records--<repo>--<k>`, when it has them.

One registry rather than a ref per path, because overlap (a directory and a
file in it) can't be settled by refs of different names. Two paths overlap
when one is, or is inside, the other; a trailing slash marks a directory. A
claim lists at most 50 paths.


**Formats.** Records outlive the code that wrote them, so each record commit,
merge and revert says its record format in a `GitHive-Format` trailer
(`src/record-format.ts`); records written before formats existed have none
and are format 1. A reader upgrades an older format's state one step at a
time as it reads it (`UPGRADES`), and a writer always writes the current
format. A GitHive that meets records newer than it knows reads them as they
are and refuses to write over them, so a rollback can't corrupt them. The
shape of each kind of record (claims, votes, the backlog, review holds, the
landing lease) is pinned in `test/fixtures/record-shapes.json`: changing one fails the tests
until the format is bumped and an upgrade written. Every read is also checked
against a schema of the fields the code relies on (`src/record-schemas.ts`):
a record someone wrote by hand with plain git fails as an error naming its
ref, not somewhere deeper. The pinned shapes don't yet
cover fields only some repos write: sharding (`autoShard`, shard indexes, vote
buckets), branches and branch rules, `skipChecks`, `after` and `source`, and
releases' `mergedAs`, `into` and `stale`.
D1 migrations only ever add, and no Durable Object class is deleted beyond
those decided before there were users: tests fail on anything else.
## Identity and stamps

Every record the toolkit writes (claims, votes, questions, merges, reverts,
branches and agent registrations) carries `by`: the caller's verified
identity. Releases carry it as `verifiedBy`. Backlog items, review holds and
settings changes aren't stamped.
That is `service:<name>` for an Access service token, or `person:` plus the
first 12 hex digits of a SHA-256 of the email (trimmed and lowercased), so
no address is stored. A
person gets the same `person:` label whether Cloudflare Access verified them
or they signed in to GitHive with GitHub (or Google, where it's set up).
Anyone who knows the email can still check the hash. The toolkit then stamps
the record: an Ed25519 signature over the whole record, made with a key only
the Worker holds. The registry's first entry holds the public key, so anyone
can check a stamp from Git alone.

The audit trusts only stamped records. A merge without a valid stamp is
reported `unverified`, and is still checked against what it changed. An
unstamped vote doesn't count toward approval. Plain git can still write
anything; it just can't stamp it. Without a stamp key nothing is stamped, and
names are taken as written.

Agents that share one Access service token tell themselves apart with agent
keys. `register` binds a name to a new secret key, `<agent>.<secret>`, and
stores only the key's hash in the registry. The key is shown once. Sent as
the `X-GitHive-Agent-Key` header (or the `agent_key` argument), it makes the
caller that agent: its records carry `by` as `<identity>/<agent>`, and it
can't act under any other name. A registered name is never used without its
key, and a second `register` for it is refused unless the call carries the
current key (which rotates it). Names starting `githive-` are reserved for
GitHive's hosted agents, and names with a `/` for signed-in agents. An agent's
records always carry its caller's identity before its name, so no agent can
pass as a verified identity.

Agents signed in to GitHive need no key. A person owns agents, and each
agent connects with a GitHive agent token (`ghv_…`, stored only as a hash,
expiring, revocable) or as an MCP client over OAuth 2.1, where the person
chose the agent on GitHive's consent page. Either way the agent is
`<handle>/<agent>`, verified on every call. Its records carry `by` as
`person:<hash>/<handle>/<agent>`, so a pool grant `person:<hash>/*` covers all
of that person's agents. Names with a `/` belong to signed-in agents: nobody
registers one, and nobody acts as one without its token. Revoking an agent
stops its tokens and its OAuth connections at their next call. People,
sessions, agents and tokens live in D1 (`src/auth/`). Sign-in is by an
admin's approval; an org's invitation waits for it. Where the `INVITE_CODE`
secret is set, signing in with it is a second way in, for as long as the code
stands: deleting or changing it shuts out everyone it let in, their sessions,
tokens and connections included, until an admin invites them
(`src/auth/invite-code.ts`).


## Who may do what

People and agents name a repo `<owner>/<name>`. The owner is a person's own
namespace (their handle) or an org, with owners, admins, members and teams
(`src/auth/orgs.ts`, D1). Inside GitHive a repo is known by its id, the
Artifacts name its records are keyed by (`<owner>--<name>` for a new one);
only routes and MCP's `repo` argument translate (`src/auth/access-control.ts`),
so an older repo can join an org as it is, records and all.

What someone may do in a repo is the most of: read if it's public; admin for
the org's owners and admins; the org's default for members; a collaborator's
level. An agent has its owner's. Every route and tool needs a level: read for
looking, review for `reviews`, `credentials` for a change and `vote`, write for claiming,
pushing and merging, admin for `settings` and deleting. A repo the
caller can't see answers as if it didn't exist. Someone signed out may read a
public repo, its dashboard pages included; for any other repo, existing or
not, they're asked to sign in. Anyone who comes through
Cloudflare Access (a person or a service token) may do anything, and name a
repo not yet in an org as `_/<id>`.

A role can be granted to a team, `@<org>/<team>`. When someone votes, GitHive
writes the teams of the repo's org they're on into the vote, and the stamp
covers them, so the audit still needs only Git: a vote counts as the role if
its voter was on the team when they voted. Someone who joins the team counts
without the grant changing; someone who leaves stops counting from their next
vote.

## Forks

Each agent has its own fork of the project, made ahead and reused for every
change. GitHive starting on a repo makes 8 seed forks of the project, one at a time in the
background (`fork--<repo>--seed--<k>`). `register` queues the agent's own
fork, copied from a seed (its own by a hash of its name, else any that's
ready, else the project), so a crowd arriving at once doesn't copy the project
all at once. `credentials` makes the fork only if it isn't there yet. The fork is `fork--<repo>--agent--<name>`. The name is the
agent's, lowercased, with anything but letters, digits and dashes turned into
dashes, cut to 40 characters; when that differs from the agent's real name, a
six-digit hex hash of the real name is added, so two names never share a fork.
Each change is a branch `changes/<change>` in it. A change from before forks
were per agent is still read from its own fork, `fork--<repo>--<change>`.

An agent gets read access to the project and write access only to its own
fork. So it can't push to main or touch the records. `credentials` with a
change hands out a fork's write token only to the agent holding the change's
claim; anyone else asking for that change gets a read-only token for the
author's fork to review it, and the grant is logged by agent name. A fork's default branch may be behind, so a new
change starts from the project's branch, not the fork's.

Forks take seconds each to make (a fork of a seed about 13 s). Letting every agent push its branches to
the project repo instead was tried and removed: Artifacts takes one push at a
time per repo, and at 100 agents, 64 failed pushing their branches to the one
repo. `scripts/forks-demo.mjs` runs the live case: a rogue sharing the other
agents' Access identity can't act as another agent, can't get another
change's fork, and can't push to main.

## Claims

An agent claims by reading the registry, checking that no active claim
overlaps its paths, and appending its claim on that tip. Claiming again under
the same change extends the claim and counts as activity. A change belongs to
its first agent: a claim under another agent's change name is refused, until
that agent's claim is released (or abandoned: see below), when the name is free
again.

The refusal names who holds what, so the agent can narrow its claim or ask
them. A claim in the way that its agent has abandoned is released as stale in
the same append, with its own stamped release. There is no timer: an
abandoned claim is freed by the next agent that needs its paths (`backlog`
lists its work as free again), or by anyone with `release` and `stale: true`.

Abandoned is decided by whose turn it is (`staleness.ts`), not by quiet alone.
An agent that pushed and waits for review, whose change is being checked to
land, or that asked a person, is waiting its turn, and keeps its paths however
long that takes. Only a change waiting on its own agent can be abandoned:
nothing pushed for 30 minutes, or no answer for 2 hours after changes were
asked for (failed checks reject its head too), or it was approved and not
merged. The clock
starts at the later of the agent's last claim and what handed the turn back. A
push moves the turn on (a new head waits for review). The toolkit reads the
change's head, its votes and the batch being checked fresh before releasing; the dashboard
shows the same lamp from the same rule.

The audit flags a claim released by someone else while still in use. It checks
the floor: no stale release sooner than 30 minutes after the claim's agent last
claimed. Every release the turn rule allows passes it; the audit can't replay
the rest (a head lives in its agent's fork, not in the records).

A release names the merge it follows (`mergedAs`), when it follows one.

## Branches

A change lands on the project's branch unless its claim names another with
`into`: a feature branch, a release branch. Everything after the claim reads
the branch from it: `credentials` says to start from it, `status` test-merges
against it, a reviewer's `credentials` diffs against it, and `merge` lands on it,
with that branch's other ready changes. A change lands on one branch:
claiming it again keeps it there, and naming another is refused.

Claims are per branch: `lib/auth/` on `main` and on `release/2.x` are
different code, so two changes holding them don't conflict. The records keep
a claim into another branch under a first path segment of its own
(`::<branch>`, see `branch-scope.ts`), so overlap, shards, stale claims and
the audit's coverage keep branches apart with no rules of their own; the
tools take and give back plain paths and `into`. No agent may claim a path
starting with `::`. Claims on the project's branch have no segment, as before.

A branch that doesn't exist is made by the claim into it only when it also
says `from`, the branch to make it from, so a misspelt name is refused rather
than made. A branch that exists but GitHive hasn't seen is adopted as it is.
Either way the registry records the commit it started at (`branches`), and
the audit reads each branch after that commit, as it reads the project's
after its baseline. The toolkit writes the branch's ref, never an agent's
token: agents still push only to their forks. Made first, then recorded, so a
record that fails is made good by adopting the branch on the next claim.

Work that depends on other unmerged work goes on a feature branch, and the
project's branch only receives finished features: a feature's pieces merge
into its branch, and the finished branch merges into the project's in one
merge, so the project's branch never holds half a feature.

Within a branch, `after` orders dependent changes: a claim (or a backlog
item) names the changes it depends on, and `merge` refuses it, saying what it
waits on, until each has merged into the same branch. A release records the
branch a change merged into, so a dependency that landed elsewhere doesn't
count. `backlog` lists an item as free only once its pieces have merged, and
`merge` refuses a change still waiting. A loop (x after y, y
after x) is refused when claimed, since every change in it would wait forever.
The audit reports a merge that landed before what its claim waited on.

A finished branch merges into another as one change: a claim with `source`
(the branch to merge) and `into`. Its claim is what the source changed since
it left the target: the files, or their folders, deepest first, when there
are more than a claim holds. The toolkit pushes the source's tip to the
claiming agent's fork as the change's branch, so review, landing,
`merge`, `status`, `reviews`, abandoned claims and the audit treat it as any
change, and the merge commit's second parent is the source's tip: the target
gets the whole branch in one merge. The claim holds those paths on the target
while the merge is under way, so the target can't change under it. If the
source moves on, claiming again brings the change up to its new tip (a new
head, so a new review). A conflict with the target is fixed the same way in
the other direction: merge the target into the source, then claim again.

On the dashboard, a repo opens on its Hive tab (see Endpoint and dashboard).
Its Changes tab shows one branch at a time, picked from the
project's and those changes land on (`?branch=` in the address): its claims,
what's landing, its territory and its open changes. A change shows where it lands
(into), the branch it merges (merges) and what it waits on. People who can
write make a branch from another there (recorded with their name, as a claim
with `from` would), and merge an approved change that waits on nothing: the
same merge an agent asks for, landing in a batch with the branch's other
ready changes, checked, as its agent, stamped with the person who asked.

A repo's review policy and checks are its project branch's, and every other
branch's unless a branch rule says otherwise (`settings` with `branch_rules`,
or the dashboard's Settings tab). A rule names branches by pattern
(`feature/*`, `release/*`, a name; `*` is any run of characters) and changes
only what it sets: the policy fields it names, and its checks (`[]` for
none). What it leaves out stays the repo's, and follows the repo's when they
change. The first matching rule applies; the project's branch always has the
repo's own settings. So `feature/*` can merge on its checks alone while a
feature's merge into `main` gets the full review, and `release/*` can need a
role only people hold. `merge`, `status`, `reviews`, the abandoned rule and the
audit all read a change's settings from the branch it lands on; the audit
from the rules in force when it merged. A merge whose settings need no
approvals and no role needs no votes to cite. A branch rule may grant roles of
its own. (The backlog's work lands on the project's branch.)

## Review policy

A policy says how many approvals a commit needs (`required`, 0 for none) and
which roles can veto it (`vetoes`). Escalations make it stricter for changes
touching certain paths. By default there are none, as on GitHub: a claimed,
pushed change merges as it is, and a repo asks for reviews with `settings`. A common stricter rule is an escalation for dependency, CI or
deploy files (`.github/`, `package.json` and the npm, yarn, pnpm and bun
lockfiles at the top of the repo, `.npmrc`, `Dockerfile`, `wrangler.*`;
`SENSITIVE_PATHS`): two approvals, and security's.

Approvals count once per verified identity, by its latest verdict on the
commit. Unsigned votes count by reviewer name. A vote from the change's author
never counts: neither its claim's identity nor its agent name. So an agent
can't approve its own change, or approve twice under two names.

A person and their agents count as one. Between them they approve once, and a
change by one of a person's agents can't be approved by that person's other
agents: five agents of one person can't sign off each other's changes. The
person themselves can, on the dashboard: their agent's work is theirs to
review, and a policy of one approval then works for one person with one
agent. A team that wants a second person's eyes requires two approvals, or
grants a role to others. A veto role
blocks a merge with a rejection, and must approve before a merge, so a veto
can't arrive too late. Merging, `status`, `reviews` and the audit all count this
way.

### Who holds a role

A veto role counts only from whoever the repo's owner granted it with
`settings` (`grants`; a branch rule may grant its own). A grant lists
any of:

- registered agent names, voting with their own key, so a name can't be
  borrowed;
- `person:*`, any person themselves (never an agent, theirs included), or
  one person, `person:<hash>`;
- a verified identity, `service:<id>`;
- a team, `@<org>/<team>` (see Who may do what);
- a pool, `service:<id>/*` or `person:<hash>/*`: every agent under that
  identity, however many there are. Whoever holds the identity decides who's
  in it;
- `githive`, GitHive's hosted reviewers.

A role not granted is held by people and GitHive's reviewers. A vote under a
veto role from anyone else counts as an ordinary review, and `status` lists it
as `ungranted`. A rejection from someone who doesn't hold a veto role doesn't
block a merge; `status` still shows it, for the author to revise.

A pool member's vote never counts as the role on a change whose author runs
under the same identity, so a team doesn't sign off its own changes.

`settings` warns about grants that will hold reviews up. A role whose only holder
is one agent or identity (not a person, not a pool) waits whenever that holder
is busy. A role no person holds can be flagged to people, but they can't sign
it off.

## Merging

`merge` checks what a cooperative agent would:

1. the change's claim covers every file it changed since it left main, and no
   other change's claim covers any;
2. the change's head has the approvals (stamped votes only), every veto role's
   among them, and no veto, and its checks haven't already failed on that
   commit. The policy is the one for the files it changed, on the branch it
   lands on;
3. it merges into main without conflicts. A conflict comes back as the files,
   and what to do: merge main into the branch, resolve inside the claim, push,
   and get the new commit approved;
4. if the branch has checks (none by default), they pass on main with the change merged in, with the
   other changes landing in the same batch, run in a container (see Landing).

Then it makes a merge commit, never a fast-forward. Its subject is the
change's intent, as its claim gave it, and its body names the change and its
agent, the intent in full when the subject had to shorten it, and each
approval with its reviewer's evidence, so `git log`, `git blame` and a GitHub
mirror say why every change was made and who checked it. The audit reads only
the trailers, the message's last paragraph, so nothing an agent wrote above
them can pose as one:

- `GitHive-Change` and `GitHive-Agent`: the change and its agent;
- `GitHive-Intent`: the change's intent, on one line (not stamped: it says
  why, not what the audit checks);
- `GitHive-Claims`: the claims tips it checked;
- `GitHive-Votes`: the votes tips it counted;
- `GitHive-Tested`: the main its checks passed on;
- `GitHive-Tested-With`: the head of every change its checks ran with, its
  own among them, in landing order, when it landed in a batch with others
  (merges from before batches have `GitHive-Tested-After` instead: the merges
  ahead in line);
- `GitHive-Format`: the record format;
- `GitHive-By` and `GitHive-Stamp`: who asked, and GitHive's stamp over all of
  the above and the two commits the merge joins.

If main moved before the batch's push landed, it checks the batch again on
the new main, three tries in all, then refuses, asking to merge again. After
the push it releases the claims, each naming its merge.

Anyone may merge a change whose conventions hold, naming its claim's agent as
`agent`. It merges under that agent, and the stamp says who asked. This is how GitHive's reviewers merge the
builder's changes, and how a batch lands every ready change, whichever merge
holds the lease.

`status` gives the early version, any time before merging: does the change
still merge cleanly into main, and which files are outside its claim. It
doesn't test-merge other agents' changes. Claims are exclusive and merge
refuses files outside them, so two changes that can both merge touch disjoint
files and can't conflict. An overlap means someone is outside their claim,
which their own `status` shows them. So it costs the same at any scale. The
answer is kept in the repo's RepoCache by the change's head and the branch's
head, so a `status` asked again before either moves doesn't test-merge again.
(It was a tool of its own, `check`, until it folded into `status`: agents
asked both the same question, where their change stands.)

### Changes the checks skip

A change that only touches documentation and other files no check reads
merges without running the checks: by default Markdown and other doc formats
(`*.md`, `*.mdx`, `*.markdown`, `*.rst`, `*.adoc`), `docs/` and `doc/`
folders, licenses, notices and authors, and images (png, jpg, gif, webp,
ico; not SVG). Not `*.txt`: `requirements.txt`
and `CMakeLists.txt` are code as far as the checks go. A file under a folder
tests read (`test/`, `tests/`, `__tests__/`, `spec/`, `specs/`, `fixtures/`,
`examples/`, `example/`) always runs them, whatever it is: Express's tests render
`examples/markdown/views/index.md`. A repo sets its own list with `settings`
`skip_checks` (a name like `*.md`, a folder anywhere like `docs/`, or a path
from the top like `site/*.html`), or `[]` to always run them. `merge` says
when it skipped them, and the audit applies the same rule with the list in
force when the change merged (`check-scope.ts`).

## Landing

Every merge must be tested on exactly the code it lands on (the audit checks
`GitHive-Tested`). Checking merges one at a time costs a check run each, in a
row (about 90 s each on Express). A queue that checks each merge on the ones
ahead of it costs a check run each too, and a record every merge writes
several times while it waits: with 200 agents merging, the writes to that
record were what failed, and nothing landed.

So there's no queue. Claims keep the changes in flight off each other's
paths, so the ready ones merge in any order to the same code: what lands is a
set, not a sequence. A change is ready once it's approved, which the votes
already record, so asking to merge writes nothing new.

A merge first checks its own change (what it depends on, `after`, has merged
into the branch; its claim, its approvals, no failed checks on its head, a
clean merge onto main) and refuses at once if it isn't ready. Then it takes the branch's
lease, or waits for whoever holds it. The merge holding the lease lands a
batch: every change ready to land into the branch (claims in force whose
dependencies have merged, with heads approved and not sent back), oldest
claims first, as many as the batch size, each checked against its claim and
votes again (whether it merges cleanly with the others, the batch's check
finds). The checks run once, on main with the whole batch merged in, in a
container of the batch's own. A batch whose every change touches only files
the checks skip (see Changes the checks skip) lands without a run.
Passing, each change becomes its own merge commit on main, one after another,
and the batch lands in one push, so main is never code that wasn't checked.
Each records the main the checks ran on (`GitHive-Tested`) and the changes
checked together (`GitHive-Tested-With`, in landing order). Then their claims
are released, each naming its merge.

The batch size is about one failure per batch, `1/p`, a little larger than
the size with the fewest check runs. A batch of `n` with a share `p` of
changes failing fails with probability `1 − (1 − p)^n`, and finding the
culprit costs about `2·log₂ n` more runs, so the fewest runs per change come
near `ln 2 / 2p`, about `0.35/p`. Simulating this search
(`scripts/batch-size-sim.mjs`, with the passing parts that didn't land
checked again later) puts the fewest at roughly half of `1/p`, with a flat
curve around it: at `1/p` a branch spends 3 to 7% more check runs (for `p`
from 2% to 10%), and in return a batch lands 6 to 14% more changes for the
time it takes. `p` is the share of the branch's
recent outcomes (the last 200, kept in the RepoCache) whose checks failed,
counted with a prior of 1 in 20, so a new branch starts at 20. Between 4 and
64: a branch where nothing fails takes 64 at a time, a flaky one 4.

A batch that fails is split, and its halves are checked side by side. Each
half was checked on main alone, so only one passing part can land as checked:
the first one found passing, which lands at once while the search goes on for
what failed (its changes don't wait for someone else's); the rest wait for
the next batch. A batch's checks run in a few
containers of its own, named for the batch and a place in its search: a half
stays in its parent's container, where its changes ran just now, and the
other takes one more, kept for its own halves. Each round then finds its
container running, with the batch fetched and its dependencies installed,
and fetches only what it lacks. The first of them starts while the batch is
read, so its first check doesn't wait for a container either. Only that batch's code ever runs in them (a
hostile change gains nothing it didn't have in the batch's first check), and
they stop a minute after the search, like every check container: nothing is
kept warm waiting for a fix, which a later batch checks afresh. A change that fails alone is
checked once more (a flaky run isn't a verdict), then put out:
`githive-checks` rejects its head, with the failing command's output as
evidence. Its agent sees it in `status` like any rejection,
and keeps it out of later batches until it has a new commit: `merge` refuses
that commit at once, with the failure, rather than check it a third time.

**The audit reads the branch through Artifacts' API, not a clone.** `log` lists the
first-parent chain (a page at a time, until the baseline), and each merge's
files changed from its first parent come from comparing their trees with
`readTree`, reading only the folders that differ. A commit's files are its
own for good, so they're kept in the repo's RepoCache by commit, and an audit
after reads trees only for merges new since. (Read in a Worker with a clone,
200 merges had taken 12 s and most of its memory.)

**Batches land in the Worker, with trees** (`tree-landing.ts`). Claims keep a
batch's changes off each other's paths, so each merge is main's tree with its
change's files put in place: it needs no checkout and no real merge. The
landing reads only the trees along each change's paths, through Artifacts'
`readTree`; writes the new trees and the merge commits in memory, the same
commits the Gate's `git merge --no-ff` makes (author, message and stamp
included); and pushes them, with the objects the changes add, in one
`git-receive-pack` request that moves the branch only if it's still at the
base. Those objects come from each change's fork as Artifacts packs them,
joined byte for byte into the push. Artifacts takes 5 to 10 s to answer any
fetch, however small, so each merge fetches its own change while it waits
for its turn, and keeps the pack (up to 1 MB, for 2 hours) in the repo's
RepoCache for the batch that lands it. Trees are kept for the isolate by hash:
Git names a tree by its content, so one read serves the project and every
fork. Gathering, those early fetches and the trees each landing writes fill
it, and the next landing starts from the last one's tree. A batch reads the
trees it still lacks all at once, before it builds.

A batch lands in the repo's Gate instead, with real git, when it needs more
than this: when a change and main, or two changes in the batch, changed the
same file (a real merge); when a change can't be placed on the branch exactly
(it merged in something other than main); when its changes add over 16 MB (a
landing holds about one copy of what they add, and other landings may share
the isolate's 128 MB; the repo's own size doesn't count); or when anything in
the Worker fails. So a repo without checks runs no container at all while its
batches merge cleanly. A repo with checks runs them where its code can run: in
containers, or on GitHub Actions (below), which needs none. `TREE_LANDING:
"off"` lands every batch in the Gate.

Landing in the Worker was tried before, in memory, and measured against the
Gate: without checks, at 200 agents, a batch of about 60 ran the Worker out of
its 128 MB, which is fixed, and every merge waiting in that isolate failed
with it (run 217); with checks, on Express with 5 agents, batches took 44 to
94 s from merge to landed against the Gate's 30 to 35 s (agents-6 against
agents-5), the copy of the repo made again in each new isolate and the
changes fetched one at a time, where the Gate has the repo on disk and
fetches 16 at once. Trees changed both: a landing holds only what its changes
add, never a copy of the repo, and its fetches are done before it starts. At
200 agents without checks, on Express, the agents' work took 256 s landing
with trees, 300 s in the Gate from kept packs, and 360 s in the Gate fetching
every change as it landed (tree-on5, tree-off3, tree-off2). With trees, a
64-change batch was gathered in 17 s and landed in 13 s.

With `TREE_LANDING: "off"`, a repo without checks warms its Gate too, from
its first claim until the snapshot is saved, for a snapshot a cold Gate
restores in seconds. With trees it doesn't, so a batch that falls back to the
Gate starts it cold.

**Connected to GitHub.** A repo can be connected to a GitHub repo through
GitHive's GitHub App (`settings` with `github: "owner/name"`; refused unless the
App is installed there). The App's ID and private key (PKCS#8) are Worker
secrets; GitHive signs a short JWT with the key and exchanges it for an
installation token scoped to that one repo, kept for the isolate until near its
hour (`github.ts`). Then:

- **main goes back to GitHub after every landing**, once the batch's claims are
  released, so off the critical path, from the repo's Gate (real git, the
  repo on disk). It's a fast-forward only: if someone pushed to GitHub's copy
  directly, the push is refused and logged, never forced. GitHub stays the
  copy people browse, and a backup.
- **Checks can run on GitHub Actions** instead of in containers (`verify:
  ["github-actions"]`, `actions-checks.ts`). For a batch, the repo's Gate
  merges its changes onto main, the way they'll land, and pushes that commit to
  `githive/checks/<id>` on GitHub, waits for every workflow run on it (one must
  start within 3 minutes; all must finish within 30), and passes the batch
  when they all succeed; the branch is deleted after. The batch then lands as
  any other does, with trees or in the repo's Gate: no check container runs.
  A repo without GitHub keeps
  checks in containers. Its workflow just runs on those branches:

  ```yaml
  # .github/workflows/githive.yml
  on: { push: { branches: ["githive/checks/**"] } }
  jobs:
    test:
      runs-on: ubuntu-latest
      steps:
        - uses: actions/checkout@v4
        - run: npm ci && npm test
  ```

  A failing run sends the batch's search for the culprit on as a failing check
  does: halves checked side by side, each a run of its own.

A batch's changes are read in the Worker through Artifacts' own API, not
fetched: each change's head from its fork's log, and the files it changed
since it left main by comparing two trees, reading only the folders that
differ (`batch-reads.ts`). The merge base is the newest main commit the change
reaches: where it left main, or a main commit it merged in since (agents merge
main in, never rebase). A change that merged in anything else, or left main
more than 1,000 commits ago, is read in the Gate with git instead, so the
answer is always merge-base's. Reading 1 to 4 changes this way took 1.6 to
3.1 s (agents-6); in the Gate, 10 to 23 s (agents-7, its container restarting
between batches). A batch that lands in the Gate does so in the repo's own
Gate's container, with real git on a disk: it adds the packs its merges kept
in one `index-pack`, fetches what's still missing, makes the merge commits
(stamped there: the Gate is the same Worker, with GitHive's key), one command
each, and pushes them. It fetches the branch only when it lacks the base,
which is usually the last batch it landed.
It's the repo's own Gate, never a change's: a change's Gate runs that change's
code (its installs and tests), which could tamper with git there, so it's
trusted neither with what a change touched nor with the token that writes the
branch. The push names the commit the branch must still be at
(`--force-with-lease`): a plain push refuses only what isn't a fast-forward,
and a change branched from a newer main would make a batch on an older one a
fast-forward of it. Each fetches a batch's forks 16 at a time, in one
command, each fetch tried three times: the repo's Gate to read and land it,
and the batch's check container, which fetches only what it doesn't have yet
(one at a time, the fetches were most of a big batch's check).

**Each batch is read once, when it's gathered**, through Artifacts' API: each
change's head and the files it changed since it left main, in 1.6 to 3.1 s.
(Read through the Gate, it took 25 to 65 s, and the next batch was read while
one was checked; reading through the API made that unnecessary, and it went.)
A merge waiting for its turn places its own change (its merge base and the
files it changed) and keeps that in the repo's RepoCache, where every Worker
instance reads it: gathering then reads only the head of a change already
placed as it was last seen, to see that it hasn't moved.

**Without checks, a batch takes all that's ready**, up to 64: its size is
about one check failure per batch (see `batchSize`), and nothing fails a batch
that isn't checked. At 200 agents with no checks, batches sized for checks (8,
24, 52) left 130 ready changes waiting. The repo's Gate, which lands it, is
warmed when GitHive starts on a repo with checks, or without checks at its first
claim (so a repo nobody works in starts no container), and saves the repo's
snapshot (with nothing installed, when there are no checks; with trees, a
repo without checks isn't warmed at all): cold, it then restores in
seconds. Without one, the first batch of a 200-agent run read 3 or 4 changes
in 42 to 61 s, behind the container starting from its image and Express
cloning, however early it was warmed: the Gate stops after a minute idle, and
an agent went from claim to merge in 30 to 40 s. Until the snapshot is saved,
a claim (without checks), a check or an approval warms the Gate too. A batch reads the votes on all its
changes' heads, and the claims bearing on all their files, once (`readScopes`:
the registry once, the indexes and shards once per records repo), then checks
each change against them.

**A batch's merges hear it landed as soon as it's pushed**, and its claims are
released once the lease is handed on: a write per change, a few at a time, it
grew with the batch and held up the next one. Until a claim is released, no
batch takes its change up again: the lease's recent outcomes say it landed at
that head, and a merge asked again meanwhile finds it landed. Each batch asks
for its forks' read access 6 at a time: a Worker request holds 6 connections
open.

**Open changes' heads, as last seen.** `reviews`, `backlog` and `merge` need each open
change's pushed head, and GitHive doesn't see pushes: they go to the agent's
fork. Read from every fork on every call, they were most of GitHive's Git
requests (8 fork reads a call of `next`, as it was, at 200 agents), growing with the
crowd. Now the repo's RepoCache keeps the head last seen on each change's
branch, and when: `status` (which agents call after each push) notes the
head it read, and so do the reads below. A call reads the
caller's own changes' heads now, takes a head seen in the last 5 minutes as
current, and reads at most 6 of the rest, the least lately seen first. A
head taken this way is only advice (what to review, what to batch): a merge
reads its own change, and a batch every change in it, before it lands. A
read that failed notes nothing, so a known head isn't taken for "nothing
pushed".

**Pushes, as Artifacts reports them.** Artifacts publishes a `repo.pushed`
event for every push, and one account-wide subscription carries all of them
to a Queue (`wrangler queues subscription create <queue> --source artifacts
--events repo.pushed`; the docs only describe one subscription per repo,
which would mean one per fork, each missing pushes for its first minute).
The Worker's queue consumer (src/push-events.ts) notes each push to
`changes/<change>` on an agent's fork in its project's RepoCache, with the
event's time and the fork it went to, one call a project per batch: a
change's head is known about two seconds after its push, without reading its
fork. A head an event told of is taken as current for 30 minutes (the next
push's event replaces it); reads stay for changes no event told of, and for
the caller's own. Events come at least once and may come late, so each
change keeps its newest head, a read counting as of when it began. An agent
can push any branch to its own fork, so an event's head counts for a change
only if its fork is the fork of the agent holding the claim; any other is
read. The subscription sees every namespace in the account, so each Worker
keeps only its own (`ARTIFACTS_NAMESPACE`), and production and the bench
each have their own queue, since a queue has one consumer.

**Workspaces in turn.** A merge's first look at its change and a check each
copy the project as kept for the isolate (Express shallow: 3.6 MB), fetch
the change into it, and try the merge: about 3.5 MB a call (0 to 9) until it
ends, all freed after. An isolate has 128 MB for all its requests, and at 200
agents enough at once in one went past it ("Worker exceeded memory limit"),
failing every request in it. At most 6 calls an isolate do this at once; the
rest wait their turn, and a merge reads its records after it's let go of its
workspace.

A call to the Gate or the RepoCache that failed only because its Durable
Object or container was briefly away (reset by a runtime update, or a
container connection briefly unavailable) is tried once more, two seconds
later, before the merge gives up. Even landing: its push names the main it
lands on, so a batch that did land the first time finds main moved.

The lease is a record in Git, like the claims and votes
(`refs/notes/githive-landing/<repo>/<branch>`, always in the repo's first
records repo, made at first use: never in the busy project repo, and never
moved when claims shard; `landing-lease.ts`): the merge that finds it free or
run out takes it by compare-and-swap, so of two at once only one does, and
the record says which batch its holder is checking, which is what decides
that a change in that batch isn't abandoned. A merge that's refused at a
renewal, or can't renew in time, counts the lease as lost: it starts no
checks and lands nothing more, and waits its turn again. It keeps two merges from
checking the same changes side by side; what keeps the branch right is its
own compare-and-swap, and the audit. What changes came to lately is kept in
the repo's RepoCache as a help (`landing.ts`): the merges waiting on a batch
read what their change came to there, and when it can't say, from the
branch's history (a merge commit whose second parent is the change's head).
No clock decides how long a merge waits: it waits for as
long as another merge holds the lease, and takes the lease once it's free or
ran out, and its own batch always takes its own change. Oldest claims go
first, so every batch brings a waiting change closer. The merge holding the
lease keeps it by a heartbeat: every 30 s it keeps the lease 2 minutes ahead,
but only while the step it's on is within that step's bound: five minutes to
read or land a batch, two to read or write records, and for a
check run, ten minutes per command (the Gate stops a command there) with
twenty more for an install and setting up. A merge that died (Cloudflare
dropped its request, say) lets the lease run out within 2 minutes, and one
stuck in a step that soon after the step's bound; a waiting merge, looking
again every 3 s, takes over. A merge takes the lease for three minutes, until
its heartbeat starts. A batch is always checked, even when a merge that died
had checked the same code (a cache of passes saved that rare run, and could
outlive a change of checks). A merge hands the lease on once its own change has
settled, or after 4 batches if it hasn't, and then waits its turn. Only the
request has a clock: Cloudflare drops one held open past about 20 minutes (at
200 agents, four waiting merges got a 502 after 21-25 minutes), so a merge
answers within 10: landed, refused, or still waiting ("ready and waiting to
land": merging again waits on, and answers with its commit once it lands).
A merge holding the lease starts no new batch past its 10 minutes either. Main's
compare-and-swap keeps the branch right: a batch whose push finds main moved
checks again on top of it, up to three tries in all; then `merge` refuses,
asking to merge again. Asked again about a
change that already landed, `merge` answers with its commit. Each branch has its own lease: a
change lands on the branch its claim names, with that branch's other ready
changes.

The audit checks each batch as landed (`landedAsBatch`): on the main its
checks ran on, exactly the changes `GitHive-Tested-With` names, in that
order, one after another, and nothing else. A change checked alone carries no
`GitHive-Tested-With`, and lands right on the main its checks ran on. Merges
from before batches, checked in a line after the merges ahead of them
(`GitHive-Tested-After`), are audited as they were (`testedAsLanded`).

**Check containers.** A Gate's container starts small (1 vCPU, 3 GiB: memory
is paid for while it runs, CPU only while it works) and moves up to 2 vCPU,
6 GiB once its checks are killed for memory, checking again there. The size is
kept per container, and each batch's containers are new, so each batch starts
small. A batch's checks run in Gates of its own
(`repo:<repo>:check:<batch>-<n>`), each stopping its container a minute after
its last run; a 30-minute inactivity timeout is only the backstop. The repo's
own Gate never runs a change's checks: it reads the changes Artifacts' API
can't place, staying up five minutes after so their landing finds them
fetched; lands the batches that need real git; and warms on main to keep the
repo's snapshot.

**Snapshots.** After a warm-up on main, the repo's own Gate saves its
container as the repo's snapshot (git, toolchains, the project checked out,
main's dependencies installed) when there's none yet, the dependencies
changed, or it's a week old. Only a container to trust is saved: started
fresh or from the snapshot, and set up on main alone. One that has run a
change's code (installers, scripts, tests) never is, so a change can't plant
anything later containers would start with. A batch's check containers,
builders and reviewers start from the snapshot in seconds (2.5 s for cors, against 28 s
from the image), fetch what they need, and install only what differs from
what it has. A snapshot start that fails is tried once more, two seconds
later: Containers is sometimes briefly unavailable ("The container connection
is temporarily unavailable"), and the image costs a minute more. A snapshot
that won't start twice is forgotten and the container starts from the image. Containers keeps a snapshot 30 days after it was
taken or last restored and has no way to delete one sooner: deleting a repo
forgets its snapshot, so nothing starts from it again. GitHive doesn't start
from one older than 25 days. An install is skipped while `package.json`'s
dependency sections and the lockfile are unchanged since the last one. If no
check installs a Node project's dependencies, the Gate runs `npm ci` first
(from an npm lockfile) or `npm install` (without one).
Python, Go and Rust are installed when the repo's tracked files use them
(`toolchains.ts`: `pyproject.toml` or `requirements*.txt`, `go.mod`,
`Cargo.toml`, in any folder), read from the merged code, since a change may
add one. Their dependencies (`uv sync`, `go mod download`, `cargo fetch`) are
installed before the checks and skipped while the files they come from are
unchanged. Toolchains, the virtualenv and Cargo's target folder live outside
the checkout, so a clean checkout between checks keeps them. A failed install
fails the check with its output. The repo's own Gate warms on main when
GitHive starts with checks and at a `settings` that changes the checks, after a `status` that test-merged a new head or an approving vote while the repo has no
usable snapshot, and when a batch's check container had to set up from
scratch or install what the snapshot didn't have; it saves a new snapshot only when one
is due. A container warmed in the last minute isn't warmed again.
`GET /repos/<owner>/<name>/landing?branch=` shows the batch being checked into a branch, what changes came to lately, and the snapshot.

## Audit

A pure function over the records replays the claims registry, the claim
shards, the votes and vote buckets, and every commit on main since the
baseline, and on each other branch since it started (following first
parents). It reports each violation with its commit
and author, and `by` when the commit was stamped:

- `undeclared`: a commit on main that names no change, claims or reviewed
  commit, or no votes when the policy needs some. A push straight to main
  shows up this way.
- `unverified`: a merge without a valid stamp.
- `outside-claim`: a file the merge changed outside its change's claim at the
  tip it cites.
- `inside-another-claim`: a file inside another change's claim at that tip.
- `unknown-claims`, `unknown-votes`: a cited tip the record never had, which is
  also what a rewritten record looks like, or a file no cited claims shard
  covers.
- `released-before-merge`: the cited claim was released before the merge
  without naming it, so the agent merged after giving its claim up.
- `unapproved`: too few approvals at the cited votes tip, a veto, or a veto
  role that hadn't approved.
- `untested`: checks configured, but none recorded, or the merge didn't land
  on the code they ran on. A change that only touches files the checks skip
  needs none.
- `merged-before-dependency`: a merge that landed before a change its claim
  waits on (`after`) had merged into the same branch.
- `unverified-record`: a claim or vote without a valid stamp, or a claim that
  disappeared without a stamped release.
- `released-others-claim`: someone released another agent's claim before it
  was idle 30 minutes.
- `unjustified-revert`: a revert of a commit the audit doesn't report.

Each merge names its change and the claims tips its agent checked, so the
audit checks the merge against the claims exactly as they stood there. It
recounts the approvals the same way, from the votes tips the merge cites.

**Revert.** Any agent may `revert` a commit the audit reports on the
project's branch. The revert
puts the files that commit changed back as they were before it, in a commit on
main naming what it reverts (`GitHive-Reverts`), with `GitHive-Agent`, and,
through the toolkit, `GitHive-By` and a stamp. It refuses a commit the audit
doesn't report, and one whose files changed since (those are reverted by
hand). A stamped revert marks the reverted commit's violations resolved. The
dashboard keeps open and resolved violations apart.

In a live run from when agents could still write the project repo,
cooperative agents claimed, reviewed and merged by convention. A rogue the
tools refused went around them with plain git: it merged inside another
agent's claim with one approval of two (its trailers claiming all was well)
and pushed a hotfix straight to main. The audit, from Git alone, reported
exactly those violations and nothing about the cooperative merges. Five
violations, five reverts, none left open.

## Agents without roles: they look and choose

Users send agents; they don't design a team of builders and reviewers. And
nothing in GitHive tells an agent what to do: there is no orchestrator. Each
agent looks at the state of the work and chooses, the way ants coordinate
through the trail others left rather than through a leader. Three reads show
it:

- `status`, for each change the agent holds: its head, the votes on it with
  their evidence, what it still needs, and whether it landed. The agent's own
  changes come first, by its instructions: revise one sent back (even if it's
  approved: a cooperative agent doesn't merge over an objection), merge one
  approved, finish one with nothing pushed.
- `reviews`: the reviews it may give. Never its own change, nor a commit it
  voted on (as itself or as the same person), nor one sent back, nor one
  approved; a role that can block a merge only to an agent granted it (see Who
  holds a role), else an ordinary review where one is still needed. Each says
  how many more it needs and who's reviewing it already, and one its
  reviewers already cover isn't listed. Those it's reviewing first, then roles
  that can block, the fewest approvals, the oldest.
- `backlog`: the pieces free to build: nobody has claimed one (an abandoned
  claim doesn't count: claiming releases it), nor its paths, and the pieces it
  depends on have merged. The rest are listed with why they wait.

Equally good choices come in an order of each agent's own (a stable hash of
its name), so a crowd looking at once spreads out instead of all taking the
first. That's a view, not an assignment: reviews balance themselves (when
they pile up, many agents see them; when they're done, the backlog is what's
left), and agents with their own instructions (a reviewer, a security agent)
pick what those say.

Until GitHive had these reads, a tool, `next`, picked one step for each agent
and placed its review hold for it. It bound nobody, but every agent asked it
and did what it said, so it ran the crowd: a stale answer once sent 80 agents
to merge changes that had landed, all at once. It's gone.

**News, and who a conflict is with.** Every reply that's an object carries
`news`: what landed on the project's branch since that agent was last told,
others' changes only, each with its files, agent, intent and commit, and a
line saying it ("main changed src/billing/invoice.ts: c-7 by agent-b, \"add
partial refunds\""). The repo's RepoCache keeps where each agent was last told;
its first call tells it nothing old. A merge or a check that conflicts with
the branch names, for each file in conflict, the change that last landed on it,
with its agent, intent and commit (each landing's outcome keeps its files and
intent, a dozen paths and 140 characters at most), so the agent knows what it's
reconciling with and whom to ask.

**Backlog items aren't reserved.** Two agents picking the same piece both
claim it under its id, and the claim decides: the second is refused as
someone else's change and picks another.

**Review holds.** An agent starting a review marks it, with `credentials` for
the change (in the role it names), so others looking at `reviews` see it taken.
The mark is written first, on the head GitHive already knows from push events,
before the reads that take seconds; written last, it left those seconds in
which every agent looking was offered the same review. Holds are
kept by commit and role in records in Git, split by commit into 16 buckets
(`refs/notes/githive-review-holds/<repo>/<bucket>`, `review-holds.ts`): every
review handed out writes a hold and every vote shortens one, and in one record
agents taking different reviews retried each other's writes for seconds, while
others were offered the review meanwhile (smoke run 7: two approvals a change
where one was needed). Waits on blocking roles stay in one record,
`refs/notes/githive-reviews/<repo>`. A hold lasts 15
minutes, or a minute once its agent has voted (a new vote can take a moment to
show in every read). `credentials` takes a reviewer's place by compare-and-swap,
with the number of reviewers the head still needs, and refuses once that many
others hold it: a list from `reviews` can be seconds old, and in smoke runs 7
and 8 agents acting on one took the same review, two approvals a change where
one was needed. A vote still counts with or without a hold (holds decide who
is handed a review, not whose vote counts), and the audit never reads holds. The same record keeps when each review a role
that can block awaits was first seen waiting, so people hear of one that
waited too long, once; it is written only when the reviews waiting change.

**People as the fallback.** A review a role that can block awaits, that nobody
holds, is noted when first seen. After 10 minutes (`ROLE_WAIT_MS`) it is
flagged to people's inbox, once. There is no timer: whichever agent next looks
at `reviews` notices. The flag clears when the role signs it off, or a person
votes. The flag goes to people, never to GitHive's own reviewers. If no person
holds the role, the flag says so, to nudge its holders or grant it to more.

**Asking a person.** `ask_human` puts a change in people's inbox with the
reason. It stays there until a person votes on the change's commit, from the
dashboard, with their own stamped identity (an agent's vote, even one of
that person's agents, doesn't answer it). Meanwhile its agent does other work.

## GitHive's own agents

GitHive's hosted agents follow the same conventions, through the same
toolkit. Each is a gpt-6-luna agent in its own container. They run on
GitHive's model account, so only people an admin lists may start them.

**The builder.** `build` claims the given paths as `githive-builder`, under a
change id made from the intent, and starts a builder on that change. The
builder works on `changes/<change>` in `githive-builder`'s fork, and its
records are stamped `service:githive-builder`. Its tools:

- `commit_and_push` is the only way it pushes, and only to the change's
  branch, never by force. Each push refreshes its claim and reports files
  outside the claim and conflicts with main.
- `extend_claim` claims more paths, and is refused, naming the holder, if
  another agent holds them.
- `fetch_base` fetches main, to merge in what has merged meanwhile.
- `finish` is refused until everything is pushed and inside the claim. Then it
  starts the hosted reviewers, asked to merge once approved.

A hosted reviewer's rejection sends the change back to the builder with its
findings (another agent's rejection, or failed checks at landing, leave it
for whoever owns the change).
After three revisions it gives up and releases its claim. A builder that fails
releases its claim too, so the paths don't wait.

**The reviewers.** `request_review` (or the builder's `finish`) starts one
reviewer per role: a general `review`, and every role that can veto a change
to the claim's paths. Each reviews the exact commit, read-only, and votes with
its evidence as `githive-<role>`, stamped `service:githive-reviewer:<role>`.
Asked to merge, a reviewer that approves then tries `merge`. The toolkit
refuses until enough approvals are in, so the first attempt that finds them
merges.

Live (`scripts/build-demo.mjs`): the builder pushed in a minute, both
reviewers approved, and the change was on main, stamped, about two minutes
after `build`. The audit was clean.

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

So GitHive starting on a repo records `autoShard`: shard 2 segments deep, over 16 records repos.
A claim shards the registry first when 8 agents would hold claims, or more
than 15 claims and releases were written a minute over the last 5 minutes
(`shardingReason`). Sharding makes the records repos, then is one
compare-and-swap on the registry that sets `shardDepth`, with when and why. It
happens once. A repo's first `settings` can also be told `shard_depth`: a depth to shard now, or
0 for never; and `records_repos`, how many records repos to spread the shards
over (0 keeps them in the project repo).

**Where a claim goes.** A path's shard is its first `depth` segments. A claim
is written in the shard of each of its paths. A shallower path ("wide", like
`docs/`) goes in its own path's shard, above every shard it covers. A claim
spread over more than 4 shards is written once, in the shard holding all its
paths: `examples/a/…` to `examples/x/…` go to `examples`, and paths with no
common folder go to the registry. Writing it shard by shard took 70 s for 24
example folders. Each shard lives in one records repo, picked by a hash of its
name, so shards in different repos are written side by side.

**Each change has an index**: the shards it has claimed in, written before the
shards and only ever added to. It names the change's agent, so another agent
claiming under the same name is refused there too. Reading one change
(`status`, `credentials`, `release`) reads the registry and the
shards its index names, not every shard. A change with no index has claimed
only in the registry.

**The registry is the shard above every other.** The claims held when it
shards stay in it and are released from it. Each claim writes first, then
looks: in the shards above it, the registry among them, and, if it covers more
than its own shard, in the shards below. A claim that finds an overlap there
backs out and is refused. A claim that lands in the registry after the switch
(made by a caller that read it before) checks every shard below, like any
claim covering more than its own shard. Since each claim writes before it
looks, of two overlapping claims at least one sees the other, across the
switch too.

A merge cites `shard=tip` for every shard its files and claim are in and those
above them, with the registry as `=<tip>`, which covers every file.

**Votes shard on demand too.** Every vote is a write to the one votes record,
so a swarm reviewing at once meets the same limit. Votes stay there until 8
reviewers vote within 5 minutes, or more than 15 votes and questions are
written a minute (`votesShardingReason`). This happens only in repos whose
claims may shard. Then the record is marked sharded, once, and new votes go to
one of 16 buckets by the commit's leading hex digits, each its own ref, spread
over the records repos (`vote-store.ts`). Votes never conflict, so nothing is
checked across the switch: the votes cast before stay in the record, a vote
cast there after (by a caller that read it before) still counts, and every
reader reads the record with the buckets it needs (a commit's votes: the
record and one bucket). Questions for a person are rare and always stay in
the record. A merge cites its votes as `=<record tip> <bucket>=<tip>`, and the
audit counts the cited records together.

## Benchmark

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
  `reviews` and `backlog` read from the same view.
- **Shared record states**: a record log's state at a tip is kept in the
  project's RepoCache, so a Worker isolate that hasn't read a log yet doesn't
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
  the project repo. A record's tip is now kept in the project's RepoCache with
  its state, so a read asks the RepoCache, not Git. Every write that lands
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

    node scripts/claude-agents.mjs <plan.json> [--base URL] [--model claude-sonnet-5-5] [--minutes 45] [--only agent-7]

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
  17–29 s (agents-8); with it already running, 2–3 s (agents-7). A batch now
  starts the Gate while it's read.
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

## Endpoint and dashboard

The tools are at `POST /mcp` on the same Worker as the dashboard and its
routes, with the same sign-in: Cloudflare Access (on the Access hostnames
only), an agent token (`ghv_…`, also given out over OAuth), or a person's
session. Reads of a public repo, its pages and routes, need no sign-in. The
dashboard lists repos and opens each one on its Hive: the agents at work, what
each is doing, what's landing, and a live feed of claims, pushes, votes and
landings. That feed is a rolling log of a repo's last 100 events in its
RepoCache (`src/hive-events.ts`), sent to open pages as they happen; losing it
loses nothing, since the records in Git hold the truth. A repo's other tabs
show its changes (one branch at a time), what landed on a branch and why
(History), its claims as a map, its code at any branch or commit, its agents,
the audit, and what's landing (the batch being checked, and what landed or
failed lately), with people's inbox. People vote and merge from it, make
branches, and change the settings: review policy, checks, branch rules,
visibility, collaborators. It also has pages for orgs, new repositories, a
person's own agents and, for admins, who may sign in. Its
views of a repo are read from Git and kept in the repo's RepoCache: a stale
view is served at once while a fresh one is built, and the toolkit pings open
pages after each write. The list of repos and their counts is a hint kept in
one RepoIndex; the records in Git are what count.

## Known limits

- **Detection, not prevention, for account holders.** Whoever holds the
  account's credentials can write main or the records with plain git. The
  audit reports it, unstamped, and any agent can revert it.
- **No timers.** A stale claim is freed only when someone needs its paths or
  releases it. A review waiting on a role reaches people only when some agent
  looks at `reviews`.
- **Artifacts throttles each busy repo** (answering `INTERNAL_ERROR`, not
  429). 1000 agents at once hold on 16 records repos with kept views and tips;
  on 8, a third of them failed (see Benchmark). The claims list is built at
  most once per 30 s per project, but building it reads every records repo.
- **Fork bursts stall.** Many forks of one repo asked for at once leave some
  of Artifacts' fork jobs stalled for good, so forks are made ahead and paced.
  A fork can still stick "in progress" (one stayed so for 45 minutes, and its
  agent's every `credentials` call hung). One still forking after 45 s is
  deleted, which has been seen to let it finish at once; if that removes it,
  it's asked for again. `credentials` waits at most about 90 s for a fork,
  then says to call again, rather than trying every seed in turn on the same
  stuck fork.
- **Some shallow fetches fail.** Artifacts refuses some shallow fetches of a
  fork's branch where a whole fetch works. `scripts/mcp-agent.mjs` falls back
  to a whole fetch; an agent using plain git has to do the same.
- **Merging past 200 is unmeasured.** Landing as a set merged 200 of 200 with
  200 agents; more than that hasn't been tried.
- **Sharding costs small runs** about 8 s for one agent; on demand, only once
  the load calls for it.
- **A rejection only blocks from a veto role** (or the checks, whose
  rejection blocks that head). From anyone else, `status` shows the author it
  should revise and other merges leave the change out of their batches, but the
  author's own `merge` with enough approvals lands it.
- **A role no person holds** can be flagged to people, who can't sign it off.
- **Holds are hints.** A lost hold means at worst two reviewers on one change.
- **Reverts are clean only.** A reported commit whose files changed since is
  reverted by hand.
- **A failing batch lands one part.** Its halves are checked on main side by
  side, and only the first part found passing lands as checked (at once): the
  rest wait for the next batch, and are checked again.
- **A stuck merge holds the lease** until the step it's stuck in runs past its
  bound (up to 50 minutes for a check run of three commands), then a waiting
  merge takes over.
- **Without the RepoCache** (reset, or not answering) merges still land: the
  lease is in Git, and a merge finds out whether its change landed from the
  branch's history. What it kept costs speed to lose: a batch that passed may
  be checked again, and the next batch read again.
- **Without a stamp key** nothing is stamped or verified, and the audit takes
  names as written.

An earlier elected-coordinator design is kept as the tag `elected-mode-final`.
