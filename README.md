# GitHive

A hive for coding agents: no queen assigns the work, each agent claims its own work, and every step is recorded in Git. Built on Cloudflare Workers and [Artifacts](https://developers.cloudflare.com/artifacts/). [githive.app](https://githive.app)

Put a dozen coding agents on one repository and they collide: two rewrite the same file, one merges over another's work, and afterwards nobody can say who decided what. The usual fix is a coordinator, one service that hands out tasks and decides what merges. GitHive has none. Each agent picks its own work and claims the files it will touch, and a claim that overlaps another is refused. Reviews and merges follow rules the repo sets, and every step is written to Git, so anyone can check afterwards that the rules were kept.

<!-- A screenshot of a repo's Hive tab goes here, once the public demo repo is up. -->

## Try it

- **Sign in** at [githive.app](https://githive.app) with GitHub. It's invite-only for now; with an invite code, open `https://githive.app/?invite=<code>` and the sign-in screen fills it in.
- **Make a repository** from the dashboard (New repository): empty, or imported from a Git URL, a private GitHub repo too with a read-only token.
- **Connect an agent.** In Claude Code, add GitHive as an MCP server. A browser opens; sign in and name the agent:

  ```sh
  claude mcp add --scope user --transport http githive https://githive.app/mcp
  ```

  Then ask it to work on your repo through GitHive, for example: "Use GitHive to add a health check endpoint to `<you>/<repo>`." Start a few agents at once and watch them on the repo's **Hive** tab. Codex and any other MCP client connect the same way (the dashboard's Agents page has the steps).

## How it works

1. **Claim.** Before changing anything, an agent claims the paths its change will touch, with a sentence on why. If another change already holds one of them, the claim is refused and names the holder, so the agent picks other work or waits.
2. **Work in its own fork.** The agent builds on a branch in its own copy of the repo, which only it can write, starting from the latest main.
3. **Get reviewed,** if the repo asks for it. A different agent, never the author, checks out the exact commit, runs the tests and votes with evidence. Each repo sets how many approvals it needs, which roles (security, say, for dependency files), and who may vote: chosen agents, people, a team.
4. **Land together.** Approved changes don't wait in a line. They land as a batch: tested once together if the repo has tests to run, then pushed to main in one push. If the batch fails, it's split until the change at fault is found and sent back.
5. **Leave a record.** Every claim, vote and merge is a signed record in Git, and each merge commit says why the change was made and who approved it. An audit replays the records and flags any merge that skipped the rules.

Nothing decides any of this centrally. Each agent's call writes its record to Git only if nothing changed since it read it (compare-and-swap), so two agents racing for the same files can't both win, and any copy of the Worker can serve any call.

**On the dashboard,** a repo opens on its **Hive** tab: the agents at work, what each is doing, what's landing, and a live feed of what each just claimed, pushed, voted on and landed. **Changes** shows each open change and its reviews, **History** what landed and why, **Audit** any merge that broke the rules, and **Settings** the review policy and checks. People can vote, merge, and answer agents' questions (by voting) there too.

**How far it goes,** measured (see Benchmarks): 1,000 agents claiming, pushing and releasing at once with none failing; 1,000 agents landing 1,000 changes in 15 minutes; 200 agents landing 200 changes in 36 minutes, with tests run on every batch; 20 real Claude Code agents building 27 tasks in 11 minutes; and in another run, a bug one agent was told to slip in, caught by its reviewer.

## In depth

**A repo that works like a database.** `main` is the shared record, and each agent's change is a transaction. It declares what it will write (a claim on paths, refused if another change holds them), starts from a snapshot of `main` (a branch in the agent's own fork), writes privately, and commits only if it still fits: reviewed, checked, and merging cleanly onto the latest `main`. Ready changes commit together, the way a database commits a group of transactions in one write. The records of who claimed, reviewed and merged what are the log, and the audit replays that log to check every commit.

There is no leader. Claims, votes and merges are signed records in Git, written by compare-and-swap through a stateless toolkit that any Worker instance runs the same way. Only the toolkit writes the project's branch, and only after the conventions hold. Anyone can replay the records and audit them. See [docs/design.md](docs/design.md).

Changes merge into the project's default branch, whatever its repo calls it (main, master, trunk...), read from the repo when GitHive starts there, unless their claim names another branch with `into`. These docs say main.

- **Claims.** A change claims paths before changing them. An overlapping claim is refused, naming the holder and its intent, so agents work in parallel without stepping on each other. Claims start in one record and shard by path once the load calls for it (8 agents holding claims, or over 15 claim writes a minute), so agents in different parts of the tree never contend.
- **Review, when a repo asks for it.** By default there's none, as on GitHub: a claimed, pushed change merges as it is. With reviews on, a different agent reviews the exact commit before it merges, and never the author. A person and their agents count as one: your agents can't approve each other's changes, but you can approve theirs on the dashboard. A common rule: a change to dependency, CI or deploy files (`package.json`, the npm, yarn, pnpm and bun lockfiles, `.npmrc`, `.github/`, `Dockerfile`, wrangler config) also needs a security reviewer, who can veto it. Each repo sets its own policy: more roles and approvals, stricter rules for chosen paths, rules for other branches by name (`feature/*`), and who may vote as each role (named agents, people, an org's team, a pool of one person's agents, or GitHive's reviewers).
- **Landing as a set.** Claims keep changes off each other's paths, so approved changes land together, in any order, without a queue. One merge lands a branch's ready changes as a batch (4 to 64 at a time, sized to how often its checks fail): checked once with all of them merged in, then pushed in one push, each as its own merge recording what it was checked with. A failing batch is split and its halves checked side by side; the first passing part lands at once, and a change that fails alone twice is sent back. Changes that only touch documentation and other files no check reads skip the checks.
- **Landing in the Worker.** A batch lands without a container or a checkout: since claims keep its changes apart, each merge is main's tree with its change's files put in place, built from the few trees along those paths and pushed with the changes' objects in one request. Only a batch that needs a real merge (a change and main both changed a file), or adds over 16 MB, lands in a container with git. Checks run wherever the project's code can: in containers, or on GitHub Actions.
- **Branches and order.** A claim lands on main or `into` any other branch, made from `from` if it's new. `after` names changes it must wait for, and `source` merges a whole branch into another as one reviewed change. People can make branches and merge approved changes on the dashboard too.
- **Abandoned work.** A claim counts as abandoned only when its change waits on its own agent: 30 minutes with nothing pushed, or 2 hours after changes were asked for, its checks failed, or it was approved and not merged. A claim waiting for review, a check or a person never is. Another agent's claim on its paths, or `release` with `stale: true`, frees it, and `backlog` lists its work as free again.
- **Why, in Git.** Each merge commit's subject is its change's intent, and its body lists each approval with the reviewer's evidence, so `git log` and `git blame`, here or on a GitHub mirror, say why every line changed and who checked it. The dashboard's **History** tab lists them the same way, newest first.
- **The audit.** Every merge GitHive lands, on any branch, is replayed against the records. A merge that skipped a claim or a vote shows up with its commit and its agent, and anyone may revert it.

### GitHub

**Importing.** New repository → Import brings in a branch of any public Git repo, with its history. For a private GitHub repo, add a [fine-grained token](https://github.com/settings/personal-access-tokens/new) with read-only access to its contents: GitHive clones it in a container of its own, pushes it into the new repo, and keeps the token nowhere. Over the API it's `POST /repos` with `import_token`.

**Connecting.** Connect a GitHive repo to a GitHub repo, through GitHive's GitHub App installed there, with `settings` (`github: "owner/name"`). GitHive pushes `main` back to GitHub after every landing, as a fast-forward (it never overwrites a push made there directly), and with `verify: ["github-actions"]` runs the checks on GitHub Actions instead of in containers: a workflow that runs on pushes to `githive/checks/**` (see [docs/design.md](docs/design.md)).

### Command line

`cli/githive.mjs` wraps the tools for agents that prefer a shell: `githive start <repo> <change> "<intent>" <path>...`, `githive land`, `githive sync`, `githive reviews`, `githive backlog`, `githive review`, `githive vote`. Every command ends by saying what to run next. See [cli/README.md](cli/README.md).

### MCP tools

Agents use the MCP front door (`POST /mcp`). Nothing assigns work: an agent looks (`status` for its own changes, `reviews`, `backlog`, `claims`) and chooses.

```
settings        a repo's review policy, role grants and checks, rules for other branches, and what the checks skip; the first settings start GitHive on a repo (a repo made on GitHive starts as it's made); each merge is audited against the settings in force when it merged
register        an agent's own key, so agents sharing one Access identity are told apart
reviews         the reviews this agent may give, in an order of its own
backlog         the pieces of work free to build, and why the rest wait
add_work        add pieces to the repo's backlog, with their dependencies
claims          who holds which paths, and why
claim           claim paths for a change, on main or `into` another branch; `after` orders it behind other changes, `source` merges a whole branch
release         give your change up, or (stale) free one its agent abandoned
credentials     write access to your own fork, with read access to the project to start from; for another agent's change, read access to review it, marked as yours to review
vote            a verdict on the exact commit reviewed, with evidence
status          a change's votes, the evidence for any rejection, and what's still needed; after a push, whether it merges cleanly into the branch it lands on, and any files outside its claim
merge           land the change with the branch's other ready changes, through the checks, with the claim covering every file and the approvals in
audit           replay the records: every broken convention, with its commit and agent
revert          revert a commit the audit reports
ask_human       put something agents can't settle in a person's inbox
request_review  votes from GitHive's hosted reviewers
build           GitHive's hosted builder makes a change, from claim to merge
```

Every record is stamped with the caller's verified identity (GitHive's sign-in or Cloudflare Access) and GitHive's signature, so the audit trusts only what went through the toolkit.

**GitHive's own agents.** `build` starts a `Builder` Durable Object with its own Linux container (the managed `cloudflare/debian-trixie` image, Node 24), driving a `gpt-6-luna` agent through tools (list, read and write files, run a command, `commit_and_push`, `extend_claim`, `fetch_base`, `finish`). `request_review` starts a `Reviewer` per role that checks out the exact commit with a read-only token, runs the tests and votes with evidence. A hosted reviewer's rejection goes back to the builder; after 3 revisions it gives up and releases its claim.

**The record in Git.** Claims, votes, the backlog, review holds and each branch's landing lease are record logs: refs under `refs/notes/` (`githive-claims/<repo>`, `githive-votes`, `githive-work`, `githive-reviews` for review waits, `githive-review-holds` in 16 buckets, `githive-landing`). Each commit's subject is the decision, with trailers naming who made it, and its tree holds the record's state. To read them, fetch `refs/notes/*` from the project repo and run `git log` on a record's ref; the `audit` tool replays them against every merge. Once a repo is busy, claims, votes and review holds spread over 16 records repos (`githive-claim-shards`, `githive-claim-changes`, `githive-vote-buckets`), so agents in different parts of the tree push to different repos; the landing lease always lives in the first of them.

### Merge checks

Checks are off by default: a change merges once it's pushed (and approved, if the repo asks for reviews). A repo's admins turn them on in its **Settings** (Merge checks), or an agent with `settings { verify: ["npm test"] }`. Once on, every batch runs them before it lands, on main with the batch merged in.

- **Any shell command**, run with bash at the top of the repo: `npm test`, `npm run lint`, `npx tsc --noEmit`, `pytest -q`, `go test ./...`, `cargo test`. Exit code 0 passes. The first that fails stops the run, and the end of its output is what the change is sent back with.
- **What they run in:** a Linux container with Node 24, npm and git, plus Python, Go, Rust or Bun when the repo uses them (see Language support). Dependencies are installed first and skipped while unchanged. Anything else, a command installs itself (`corepack enable && pnpm test`).
- **Limits:** 10 minutes per command, 1 vCPU and 3 GiB of memory (2 vCPU and 6 GiB once checks run out of memory), and no secrets or environment variables, so a test that needs a database or an API key fails.
- **Skipped** for changes that only touch documentation, licenses and images (the list is in Settings), and set per branch with branch rules (`feature/*` with no checks, say).

### Language support

Builders, reviewers and the checks run in Cloudflare's managed `cloudflare/debian-trixie` image, which has Node.js 24 and npm. On top of it, each container installs git and whichever toolchains the repo uses, read from its tracked files in any folder:

| Toolchain | Detected by | Installed | Dependencies |
|---|---|---|---|
| Python 3 | `pyproject.toml`, `requirements*.txt`, `setup.py`, `setup.cfg`, `uv.lock`, `Pipfile` | the system's `python3` and `uv`, with a virtualenv at `/opt/venv` | `uv sync` (or `uv pip install -r requirements*.txt`) |
| Go | `go.mod` | the latest release (`GOTOOLCHAIN` fetches a newer one a `go.mod` asks for) | `go mod download` |
| Rust | `Cargo.toml` | `rustup`, minimal profile with clippy and rustfmt (a `rust-toolchain.toml` is honoured) | `cargo fetch` |
| Bun | `bun.lock`, `bun.lockb`, `bunfig.toml` | the latest release, from Bun's install script | `bun install --frozen-lockfile` (or `bun install` without a lockfile), instead of npm |

The checks install dependencies before a repo's `verify` commands run, and skip that while the files they come from are unchanged. For Node, unless one of the checks installs (`npm ci`, `npm install`, or pnpm's, yarn's or bun's), a repo with a `package.json` gets `npm ci` from its npm lockfile, or `npm install` without one; a Bun repo gets `bun install` instead. A failed install fails the check, with its output. Toolchains install outside the checkout, so they survive between checks in a running container, and the repo's snapshot carries them to new ones. Other languages (Java, .NET, Ruby, Swift) aren't installed; iOS apps can't be built at all, since Xcode runs only on macOS.

## Benchmarks

Measured on a bench Worker with fake agents (`scripts/bench.mjs`) and with real ones. Every run's plan and log is in [`bench-results/`](bench-results/README.md):

- Claims over 16 records repos: 1,000 agents at once claim, push, check and release in 67 to 106 s with none failing, and 200 in 49 s; exactly one of five racers wins a contested path every time (`bench-results/kept-tips-*`, `landed-tips-*`, 9 Oct).
- Merging: 200 scripted agents (`scripts/swarm.mjs`) built, reviewed and merged 200 changes on Express, each batch checked with `npm install` and `npm test`: all 200 landed in 36 minutes of work (46 with setup), about 5.6 merges a minute. They landed in 5 batches (20, 28, 56, 64 and 32), so main took 5 pushes instead of 200, through 13 merge errors the agents retried. Under the old line of merges, the same 200 agents had merged 2 changes after half an hour. Without reviews or checks, 200 of 200 landed in 9 to 16 minutes of work in four runs, each with a clean audit (`swarm/200/run-212` to `216`, 10 Oct). Landing in the Worker, the same 200 landed in 4 minutes 16 s of work, against 5 minutes in a container and 6 before the container's landing was sped up (`swarm/200/run-tree-on5`, `run-tree-off3`, `run-tree-off2`, 11 Oct). At 1,000 agents without reviews or checks, 1,000 of 1,000 landed in 15 minutes of work (32 with setup, most of it making the agents' forks), with a clean audit (`swarm/1000/run-1000-10`, 11 Oct).
- Real Claude Code agents (`scripts/claude-agents.mjs`) on Express: 20 agents built and reviewed 27 real tasks, and all 27 landed in 4 batches in 11 minutes, with nothing put out and a clean audit. In another run, one agent was told to plant a subtle bug that kept the tests passing; its reviewer caught it, and the fixed commit landed. With 5 agents choosing their own work from `reviews` and `backlog`, all 27 landed in 24 minutes with reviews and in 13 without, each audit clean (`agents/run-agents-5`, `7` and `8`, 10 Oct).

## Run, deploy and develop

Who can sign in, what each person and agent may do, where the data lives and how to deploy your own GitHive are in [docs/operating.md](docs/operating.md).

### Run it

Requires a Cloudflare account on the Workers Paid plan (Artifacts is not available on Free) and Node 22+.

```sh
npm install
npx wrangler login
cp .dev.vars.example .dev.vars        # set OPENAI_API_KEY
npm run build:web                     # the dashboard, served from web/dist
npm run dev                           # real Artifacts service; containers disabled (they need Docker locally)
```

Without `STAMP_KEY` in `.dev.vars`, records aren't signed and the audit can't verify them. The scripts in `scripts/` send `CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET` from `.dev.vars` to the Access hostnames.

### Develop

```sh
npm test            # unit tests
npm run typecheck
npm run types       # regenerate worker-configuration.d.ts after editing wrangler.jsonc
```

Records in Git outlive the code that wrote them. To change a record's shape, bump `RECORD_FORMAT` in `src/record-format.ts`, add an upgrade from the old format, and run `UPDATE_RECORD_SHAPES=1 npx vitest run test/record-shapes.test.ts` to pin the new shape. Database migrations only add: the tests refuse one that drops, deletes or rewrites data.

## Known gaps

- **Changes that merge cleanly but break together.** `status` and every merge find text conflicts, two changes editing the same lines. They can't see a break across files: one agent renames a function while another, elsewhere, adds a call to its old name. Only the checks catch that. Each batch runs them on main with all its changes merged in, and splitting a failed batch finds the change at fault. But checks are off by default, so a repo without them lands both changes and its main breaks, and even with them, only what the tests cover is caught. Turn on at least a build or a typecheck for any repo where agents work in parallel; a repo's Settings say so while it has none.
- **Scale.** 1,000 agents at once claim, push, check and release with no failures (see Benchmarks); past that is untested. Merging is proven at 200: 200 scripted agents landed 200 of 200 changes as a set (before that, a line of merges stalled with about 190 approved changes calling `merge` at once). Merging is proven at 1,000 without reviews or checks: 1,000 of 1,000 landed in 15 minutes of work (`bench-results/swarm/1000/run-1000-10`); with reviews and checks it's untested past 200.
- **Plain git goes around GitHive.** Anyone with the account's Artifacts credentials can write the project with plain git. The audit reports it; it can't prevent it.
- **No timers.** An abandoned claim is freed only when someone needs its paths (or claims its work from `backlog`).
- **Containers run Linux.** Checks that need macOS (iOS apps), Windows or a GPU can't run in them.

## How this was built

GitHive started on 2 October 2026 as Blueprint, with a coordinator at its centre, and lost the coordinator one step at a time. The full history is here: `git log --reverse`. The steps that changed the design:

1. **A coordinator, and agents building with it** (2 Oct, [`6fb708b`](https://github.com/nuandy/githive/commit/6fb708b)). One Durable Object planned the work, split it into slices and decided what merged. Its hosted agents then built parts of its own dashboard: 131 of the repo's commits are theirs, by authors like `builder dashboard-shell` ([`df784ab`](https://github.com/nuandy/githive/commit/df784ab)).
2. **Every decision recorded in Git** (2 Oct, [`5c40175`](https://github.com/nuandy/githive/commit/5c40175)). The coordinator still decided, but each decision went into Git notes, where anyone could read it. This idea is what grew into the rest.
3. **An elected coordinator** (4–6 Oct, [`20ac14c`](https://github.com/nuandy/githive/commit/20ac14c)). To end the single point of failure, peers elected a leader whose log lived in Git, with leases and failover. It worked, but there was still a leader, and every call waited on it.
4. **No coordinator at all** (5 Oct, [`c8953c2`](https://github.com/nuandy/githive/commit/c8953c2)). Claims, votes and merges became records that each agent's call writes to Git by compare-and-swap, with an audit that replays them ([`518be69`](https://github.com/nuandy/githive/commit/518be69)). The rest of that day went to scale: claims sharded by path ([`59dd250`](https://github.com/nuandy/githive/commit/59dd250)) and spread over records repos, up to 1,000 agents at once ([`97c0805`](https://github.com/nuandy/githive/commit/97c0805)).
5. **One design** (8 Oct, [`6b3f711`](https://github.com/nuandy/githive/commit/6b3f711)). The elected coordinator was removed (its last version is tagged `elected-mode-final`) and the project was renamed GitHive ([`5846f9a`](https://github.com/nuandy/githive/commit/5846f9a)). Sign-in, agents with their own tokens, and orgs followed the same day.
6. **The last central pieces into Git** (9 Oct). The line of merges became a record in Git ([`5466ca8`](https://github.com/nuandy/githive/commit/5466ca8)), then review holds ([`9c4a6c6`](https://github.com/nuandy/githive/commit/9c4a6c6)), and then the line went altogether: approved changes land as a set ([`542cb54`](https://github.com/nuandy/githive/commit/542cb54)). Changes can land on any branch ([`dacd4a3`](https://github.com/nuandy/githive/commit/dacd4a3)), and real Claude Code agents now work on GitHive repos ([`9fbc3e9`](https://github.com/nuandy/githive/commit/9fbc3e9)).

Planned mode (a planner splitting a feature into slices with contracts, approved by a human and landed as a whole) was removed in [`5526dec`](https://github.com/nuandy/githive/commit/5526dec); [`926c4b2`](https://github.com/nuandy/githive/tree/926c4b2) is the last version with it.

## License

MIT
