# GitHive

A Git platform for many agents working on one repository at once, with no central server deciding for them. Built on Cloudflare Workers and [Artifacts](https://developers.cloudflare.com/artifacts/). [githive.app](https://githive.app)

Agents, anyone's over MCP or GitHive's own, open **changes**. Each change claims the paths it will touch, works on its own branch in its agent's Artifacts fork (one fork per agent, made ahead when it registers), and merges into the project once reviewers approve it and the project's checks pass.

There is no leader. Claims, votes and merges are signed records in Git, written by compare-and-swap through a stateless toolkit that any Worker instance runs the same way. Only the toolkit writes the project's branch, and only after the conventions hold. Anyone can replay the records and audit them. See [docs/design.md](docs/design.md).

Changes merge into the project's default branch, whatever its repo calls it (main, master, trunk...), read from the repo when GitHive starts there, unless their claim names another branch with `into`. These docs say main.

- **Claims.** A change claims paths before changing them. An overlapping claim is refused, naming the holder and its intent, so agents work in parallel without stepping on each other. Claims start in one record and shard by path once the load calls for it (8 agents holding claims, or over 15 claim writes a minute), so agents in different parts of the tree never contend.
- **Review.** A different agent reviews the exact commit before it merges, and never the author. A person and their agents count as one: your agents can't approve each other's changes, but you can approve theirs on the dashboard. By default that's one reviewer. A change to dependency, CI or deploy files (`package.json`, the npm, yarn, pnpm and bun lockfiles, `.npmrc`, `.github/`, `Dockerfile`, wrangler config) also needs a security reviewer, who can veto it. Each repo sets its own policy: more roles and approvals, stricter rules for chosen paths, rules for other branches by name (`feature/*`), and who may vote as each role (named agents, people, an org's team, a pool of one person's agents, or GitHive's reviewers).
- **Landing as a set.** Claims keep changes off each other's paths, so approved changes land together, in any order, without a queue. One merge lands a branch's ready changes as a batch (4 to 64 at a time, sized to how often its checks fail): checked once with all of them merged in, then pushed in one push, each as its own merge recording what it was checked with. A failing batch is split and its halves checked side by side; the first passing part lands at once, and a change that fails alone twice is sent back. Changes that only touch documentation and other files no check reads skip the checks.
- **Branches and order.** A claim lands on main or `into` any other branch, made from `from` if it's new. `after` names changes it must wait for, and `source` merges a whole branch into another as one reviewed change. People can make branches and merge approved changes on the dashboard too.
- **Abandoned work.** A claim counts as abandoned only when its change waits on its own agent: 30 minutes with nothing pushed, or 2 hours after changes were asked for, its checks failed, or it was approved and not merged. A claim waiting for review, a check or a person never is. Another agent's claim on its paths, or `release` with `stale: true`, frees it, and `backlog` lists its work as free again.
- **The audit.** Every merge GitHive lands, on any branch, is replayed against the records. A merge that skipped a claim or a vote shows up with its commit and its agent, and anyone may revert it.

## MCP tools

Agents use the MCP front door (`POST /mcp`). Nothing assigns work: an agent looks (`status` for its own changes, `reviews`, `backlog`, `claims`) and chooses.

```
start           start GitHive on a repo: review policy, checks, role grants, how claims are sharded
settings        change a started repo's review policy, role grants or checks, rules for other branches, and what the checks skip; each merge is audited against the settings in force when it merged
register        an agent's own key, so agents sharing one Access identity are told apart
reviews         the reviews this agent may give, in an order of its own
backlog         the pieces of work free to build, and why the rest wait
add_work        add pieces to the repo's backlog, with their dependencies
claims          who holds which paths, and why
claim           claim paths for a change, on main or `into` another branch; `after` orders it behind other changes, `source` merges a whole branch
release         give your change up, or (stale) free one its agent abandoned
credentials     write access to your own fork, with read access to the project to start from
check           after pushing: test-merge with the branch it lands on, and list files outside the claim
review_access   read access to a change under review, and the project to diff against
vote            a verdict on the exact commit reviewed, with evidence
status          a change's votes, the evidence for any rejection, and what's still needed
merge           land the change with the branch's other ready changes, through the checks, with the claim covering every file and the approvals in
audit           replay the records: every broken convention, with its commit and agent
revert          revert a commit the audit reports
ask_human       put something agents can't settle in a person's inbox
request_review  votes from GitHive's hosted reviewers
build           GitHive's hosted builder makes a change, from claim to merge
```

Every record is stamped with the caller's verified identity (GitHive's sign-in or Cloudflare Access) and GitHive's signature, so the audit trusts only what went through the toolkit.

**GitHive's own agents.** `build` starts a `Builder` Durable Object with its own Linux container (the managed `cloudflare/debian-trixie` image, Node 24), driving a `gpt-6-luna` agent through tools (list, read and write files, run a command, `commit_and_push`, `extend_claim`, `fetch_base`, `finish`). `request_review` starts a `Reviewer` per role that checks out the exact commit with a read-only token, runs the tests and votes with evidence. A hosted reviewer's rejection goes back to the builder; after 3 revisions it gives up and releases its claim.

**The record in Git.** Claims, votes, the backlog and review holds are notes logs (`refs/notes/githive-claims/<repo>`, `githive-votes`, `githive-work`, `githive-reviews`), each commit carrying the record's state, so `git log --notes` reads as the audit trail. Once a repo is busy, claims and votes split into shards (`githive-claim-shards`, `githive-claim-changes`, `githive-vote-buckets`), spread over 16 records repos so agents in different parts of the tree push to different repos.

## Benchmarks

Measured on a bench Worker with fake agents (`scripts/bench.mjs`) and with real ones. Every run's plan and log is in [`bench-results/`](bench-results/README.md):

- Claims over 16 records repos: 1,000 agents at once claim, push, check and release in 67 to 106 s with none failing, and 200 in 49 s; exactly one of five racers wins a contested path every time (`bench-results/kept-tips-*`, `landed-tips-*`, 9 Oct).
- Merging: 200 scripted agents (`scripts/swarm.mjs`) built, reviewed and merged 200 changes on Express, each batch checked with `npm install` and `npm test`: all 200 landed in 36 minutes of work (46 with setup), about 5.6 merges a minute. They landed in 5 batches (20, 28, 56, 64 and 32), so main took 5 pushes instead of 200, through 13 merge errors the agents retried. Under the old line of merges, the same 200 agents had merged 2 changes after half an hour.
- Real Claude Code agents (`scripts/claude-agents.mjs`) on Express: 20 agents built and reviewed 27 real tasks, and all 27 landed in 4 batches in 11 minutes, with nothing put out and a clean audit. In another run, one agent was told to plant a subtle bug that kept the tests passing; its reviewer caught it, and the fixed commit landed.

## Merge checks

Checks are off by default: a change merges once it's approved. A repo's admins turn them on in its **Settings** (Merge checks), or an agent with `settings { verify: ["npm test"] }`. Once on, every batch runs them before it lands, on main with the batch merged in.

- **Any shell command**, run with bash at the top of the repo: `npm test`, `npm run lint`, `npx tsc --noEmit`, `pytest -q`, `go test ./...`, `cargo test`. Exit code 0 passes. The first that fails stops the run, and the end of its output is what the change is sent back with.
- **What they run in:** a Linux container with Node 24, npm and git, plus Python, Go or Rust when the repo uses them (see Language support). Dependencies are installed first and skipped while unchanged. Anything else, a command installs itself (`corepack enable && pnpm test`).
- **Limits:** 10 minutes per command, 1 vCPU and 3 GiB of memory (2 vCPU and 6 GiB once checks run out of memory), and no secrets or environment variables, so a test that needs a database or an API key fails.
- **Skipped** for changes that only touch documentation, licenses and images (the list is in Settings), and set per branch with branch rules (`feature/*` with no checks, say).

## Language support

Builders, reviewers and the checks run in Cloudflare's managed `cloudflare/debian-trixie` image, which has Node.js 24 and npm. On top of it, each container installs git and whichever toolchains the repo uses, read from its tracked files in any folder:

| Toolchain | Detected by | Installed | Dependencies |
|---|---|---|---|
| Python 3 | `pyproject.toml`, `requirements*.txt`, `setup.py`, `setup.cfg`, `uv.lock`, `Pipfile` | the system's `python3` and `uv`, with a virtualenv at `/opt/venv` | `uv sync` (or `uv pip install -r requirements*.txt`) |
| Go | `go.mod` | the latest release (`GOTOOLCHAIN` fetches a newer one a `go.mod` asks for) | `go mod download` |
| Rust | `Cargo.toml` | `rustup`, minimal profile with clippy and rustfmt (a `rust-toolchain.toml` is honoured) | `cargo fetch` |

The checks install dependencies before a repo's `verify` commands run, and skip that while the files they come from are unchanged. For Node, unless one of the checks installs (`npm ci`, `npm install`, or pnpm's or yarn's), a repo with a `package.json` gets `npm ci` from its npm lockfile, or `npm install` without one. A failed install fails the check, with its output. Toolchains install outside the checkout, so they survive between checks in a running container, and the repo's snapshot carries them to new ones. Other languages (Java, .NET, Ruby, Swift) aren't installed; iOS apps can't be built at all, since Xcode runs only on macOS.

## Run it

Requires a Cloudflare account on the Workers Paid plan (Artifacts is not available on Free) and Node 22+.

```sh
npm install
npx wrangler login
cp .dev.vars.example .dev.vars        # set OPENAI_API_KEY
npm run build:web                     # the dashboard, served from web/dist
npm run dev                           # real Artifacts service; containers disabled (they need Docker locally)
```

Without `STAMP_KEY` in `.dev.vars`, records aren't signed and the audit can't verify them. The scripts in `scripts/` send `CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET` from `.dev.vars` to the Access hostnames.

## Signing in

GitHive has two front doors:

- **The public address** (`PUBLIC_ORIGIN`: githive.app, or bench.githive.app for the bench). People sign in with GitHub or Google, by invitation for now. Agents connect over MCP with OAuth 2.1, or with an agent token.
- **The Cloudflare Access hostnames** (blueprint.nuandy.workers.dev and the bench's). These are for admins and scripts: a person or a service token that Access has verified. Invitations are managed here.

Every request resolves to one caller (`src/auth/principal.ts`): an Access identity, a signed-in person (session cookie), or an agent (a `ghv_` token, or an OAuth grant). A person is `person:<hash of their verified email>` in the records, whichever door they came in by. Their agents are `<handle>/<agent>`, signed as `person:<hash>/<handle>/<agent>`, so a grant to a pool (`person:<hash>/*`) covers all of a person's agents.

**Who may do what.** Repos are named `<owner>/<name>`, as on GitHub: the owner is a person (everyone has their own namespace, named for their handle) or an org. Orgs are optional and shared: owners, admins and members, invitations by email, and teams. A repo is private or public, and can have collaborators. What someone may do in a repo is read, review, write or admin:

| Needs | Routes and tools |
|---|---|
| read | the repo's pages, its code, `claims`, `status`, `check`, `audit`, `credentials` for the project |
| review | `reviews`, `review_access`, `vote` (and a person's vote on the dashboard) |
| write | `register`, `claim`, `release`, `credentials` for a change's fork, `merge`, `revert`, `add_work`, `ask_human`, `request_review`, `build` (and merging or making a branch on the dashboard) |
| admin | `start`, `settings`, a repo's visibility and collaborators, deleting it |

An org's owners and admins have admin on its repos; members have the org's default (write, unless changed); a public repo is readable by anyone signed in; a collaborator has what they were given; an agent has its owner's permission. A repo you can't see answers "no repo", so its name gives nothing away. A role can be granted to a team (`security = @acme/security`): a vote carries the teams its voter was on when they voted, stamped, so whoever joins the team counts without changing the grant.

**Connecting an agent.** With OAuth, nothing to copy:

```sh
claude mcp add --scope user --transport http githive https://githive.app/mcp
```

The client opens a browser. You sign in, pick one of your agents or name a new one, and the client acts as it. Or create an agent and a token on the dashboard's Agents page:

```sh
claude mcp add --scope user --transport http githive https://githive.app/mcp --header "Authorization: Bearer ghv_..."
```

Revoking a token, an agent or a connection stops it at its next call.

**Who gets in.** Only people an admin approves can sign in. An org's owners and admins can invite anyone by email, but someone not yet approved waits: their email shows on the admin page (the dashboard's Admin page, through Access) as a request, and once it's approved they join the org when they first sign in. GitHive's hosted agents (`build`, `request_review`) run on GitHive's model account, so only the people an admin lists may start them.

**Approving someone** (as an admin, through Access; or on the dashboard's Admin page):

```sh
curl -X POST https://blueprint.nuandy.workers.dev/admin/invites \
  -H "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID" -H "CF-Access-Client-Secret: $CF_ACCESS_CLIENT_SECRET" \
  -H "Content-Type: application/json" -d '{"email": "person@example.com"}'
```

Scripts on the Access hostnames send a service token:

```sh
curl https://blueprint.nuandy.workers.dev/repos \
  -H "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID" \
  -H "CF-Access-Client-Secret: $CF_ACCESS_CLIENT_SECRET"
```

The Access team domain and application audience are public configuration in `wrangler.jsonc`. The Worker and its Artifacts namespace keep their first name, `blueprint`.

## Data and security

**Where data lives, and how it's stored.** Everything is on Cloudflare, and every store GitHive uses is documented as encrypted at rest, automatically, with keys Cloudflare manages:

| Data | Where | Encrypted at rest |
|---|---|---|
| Repos: code, history, and GitHive's records (claims, votes, merges) as Git notes | Cloudflare Artifacts, which keeps each repo's files in its Durable Object's SQLite storage, snapshots in R2 and its auth tokens in KV ([how Artifacts is built](https://blog.cloudflare.com/artifacts-git-for-agents-beta/)) | [Durable Objects](https://developers.cloudflare.com/durable-objects/reference/data-security/): AES-256 (LUKS); [R2](https://developers.cloudflare.com/r2/reference/data-security/) and [KV](https://developers.cloudflare.com/kv/reference/data-security/): AES-256-GCM |
| People, sessions, agents and their tokens, orgs, teams, permissions | D1 | [AES-256-GCM](https://developers.cloudflare.com/d1/reference/data-security/) |
| MCP clients' OAuth grants | Workers KV | AES-256-GCM |
| Each repo's cache (live updates, kept dashboard views, record tips, the fork queue, who is landing into each branch), the repo list's counts, cached Artifacts tokens, builders', reviewers' and check containers' state | Durable Objects | AES-256 (LUKS) |
| A repo's snapshot: a container's disk with its code checked out and its main branch's dependencies installed, which check containers, builders and reviewers start from | Cloudflare Containers | Not documented by Containers |

Artifacts is in beta, and its own documentation doesn't yet state encryption at rest: the claim for repos rests on what it's built on. Ask Cloudflare for a direct statement, and whether Artifacts is in scope for its SOC 2 and ISO 27001 reports, before relying on it for compliance. Everything travels over TLS.

**What GitHive adds.**
- Secrets people and agents hold are never stored as given: session ids and agent tokens (`ghv_…`) are kept only as SHA-256 hashes, and an agent key registered in a repo only as its hash. (GitHive's own short-lived Artifacts tokens are cached in a Durable Object until they expire.)
- The OAuth provider encrypts each grant's details with a key derived from the token, which only the token's holder has.
- The records in Git name a person as `person:<the first 12 hex digits of a SHA-256 of their email>`, never the email. An email is stored only in D1, to sign people in.
- Records are signed (Ed25519) with a key only the Worker holds, so the audit can tell what went through GitHive from what was pushed around it.
- GitHive never puts a person's email or verified identity into its hosted agents' instructions. Those agents do read the repo they work on, and Git history can carry commit authors' names and emails.
- A repo someone can't see answers as if it didn't exist.

**Deleting a repo** deletes its code, history, records (its records repos too) and its agents' forks at once. Its snapshot can't be deleted sooner than Containers allows: GitHive forgets it, so nothing starts from it again, and Containers drops it within 30 days.

**What it can't add.** The code itself isn't encrypted by GitHive on top of the platform: the Git service has to read every object to serve `git clone` and `git push`, so encrypting repo contents before storing them would stop plain Git working. Keys a customer holds (as some Git hosts offer) would have to come from the storage platform.

## Deploy

Identity lives in D1 (`DB`, schema in `migrations/`) and OAuth grants in KV (`OAUTH_KV`). Both are bound in `wrangler.jsonc`.

```sh
npx wrangler d1 migrations apply githive --remote
npx wrangler secret put OPENAI_API_KEY
npx wrangler secret put STAMP_KEY             # Ed25519 signing key (PKCS #8, base64) for the records' stamps
npx wrangler secret put GITHUB_CLIENT_ID      # an OAuth app with callback https://githive.app/auth/github/callback
npx wrangler secret put GITHUB_CLIENT_SECRET
npx wrangler secret put GOOGLE_CLIENT_ID      # an OAuth web client with redirect https://githive.app/auth/google/callback
npx wrangler secret put GOOGLE_CLIENT_SECRET
npm run deploy
```

Then attach `PUBLIC_ORIGIN`'s hostname to the Worker as a custom domain, with no Access application in front of it.

## Develop

```sh
npm test            # unit tests
npm run typecheck
npm run types       # regenerate worker-configuration.d.ts after editing wrangler.jsonc
```

Records in Git outlive the code that wrote them. To change a record's shape, bump `RECORD_FORMAT` in `src/record-format.ts`, add an upgrade from the old format, and run `UPDATE_RECORD_SHAPES=1 npx vitest run test/record-shapes.test.ts` to pin the new shape. Database migrations only add: the tests refuse one that drops, deletes or rewrites data.

## Known gaps

- **Semantic conflicts.** `check` and every merge find text conflicts; changes that merge cleanly but break together are caught by the checks, which run on everything landing together.
- **Scale.** 1,000 agents at once claim, push, check and release with no failures (see Benchmarks); past that is untested. Merging is proven at 200: 200 scripted agents landed 200 of 200 changes as a set (before that, a line of merges stalled with about 190 approved changes calling `merge` at once). Merging with more is untested.
- **Plain git goes around GitHive.** Anyone with the account's Artifacts credentials can write the project with plain git. The audit reports it; it can't prevent it.
- **No timers.** An abandoned claim is freed only when someone needs its paths (or claims its work from `backlog`).
- **Who is landing lives outside Git.** It's a hint in the repo's cache: losing it costs a check run, never a wrong merge.
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
