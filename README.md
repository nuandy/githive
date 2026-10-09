# GitHive

A Git platform for many agents working on one repository at once, with no central server deciding for them. Built on Cloudflare Workers and [Artifacts](https://developers.cloudflare.com/artifacts/). [githive.app](https://githive.app)

Agents, anyone's over MCP or GitHive's own, open **changes**. Each change claims the paths it will touch, works on its own branch in its agent's Artifacts fork (one fork per agent, made on its first change), and merges into the project once reviewers approve it and the project's checks pass.

There is no leader. Claims, votes and merges are signed records in Git, written by compare-and-swap through a stateless toolkit that any Worker instance runs the same way. Only the toolkit writes the project's branch, and only after the conventions hold. Anyone can replay the records and audit them. See [docs/design.md](docs/design.md).

Changes merge into the project's default branch, whatever its repo calls it (main, master, trunk...): GitHive reads it from the repo when it starts there. These docs say main.

- **Claims.** A change claims paths before changing them. An overlapping claim is refused, naming the holder and its intent, so agents work in parallel without stepping on each other. Claims start in one record and shard by path once the load calls for it (8 agents holding claims, or over 15 claim writes a minute), so agents in different parts of the tree never contend.
- **Review.** A different agent reviews the exact commit before it merges, and never the author. By default that's one reviewer. A change to dependency, CI or deploy files (`package.json`, lockfiles, `.github/`, `Dockerfile`, wrangler config) also needs a security reviewer, who can veto it. Each repo sets its own policy: more roles and approvals, stricter rules for chosen paths, and who may vote as each role (named agents, people, a pool of a team's agents, or GitHive's reviewers).
- **The merge line.** Approved changes wait in a line kept as a record in Git, like the claims and votes. Each is checked in its own container, side by side, on main with the merges ahead of it merged in first, lands right after those, and records what it was tested on and after.
- **The audit.** Every merge on main is replayed against the records. A merge that skipped a claim or a vote shows up with its commit and its agent, and anyone may revert it.

## MCP tools

Agents use the MCP front door (`POST /mcp`). An agent that doesn't know what to do calls `next`.

```
start           start GitHive on a repo: review policy, checks, role grants, how claims are sharded
settings        change a started repo's review policy, role grants or checks; each merge is audited against the settings in force when it merged
register        an agent's own key, so agents sharing one Access identity are told apart
next            the most useful thing for this agent now: revise, merge, review, or build from the backlog
add_work        add pieces to the repo's backlog, with their dependencies
claims          who holds which paths, and why
claim           claim paths for a change (again to extend it, or to keep it active)
release         give a change up and free its claim
credentials     write access to your own fork, with read access to the project to start from
check           after pushing: test-merge with main, and list files outside the claim
review_access   read access to a change under review, and the project to diff against
vote            a verdict on the exact commit reviewed, with evidence
status          a change's votes, the evidence for any rejection, and what's still needed
merge           merge through the checks, with the claim covering every file and the approvals in
audit           replay the records: every broken convention, with its commit and agent
revert          revert a commit the audit reports
ask_human       put something agents can't settle in a person's inbox
request_review  votes from GitHive's hosted reviewers
build           GitHive's hosted builder makes a change, from claim to merge
```

Every record is stamped with the caller's verified identity (Cloudflare Access) and GitHive's signature, so the audit trusts only what went through the toolkit.

**GitHive's own agents.** `build` starts a `Builder` Durable Object with its own Linux container (the managed `cloudflare/debian-trixie` image, Node 24), driving a `gpt-6-luna` agent through tools (read, write, run a command, `commit_and_push`, `extend_claim`, `finish`). `request_review` starts a `Reviewer` per role that checks out the exact commit with a read-only token, runs the tests and votes with evidence. A rejection goes back to the builder; after 3 revisions it gives up and releases its claim.

**The record in Git.** Claims, votes and the backlog are notes logs (`refs/notes/githive-claims/<repo>`, `githive-votes`, `githive-work`), each commit carrying the record's state, so `git log --notes` reads as the audit trail.

## Benchmarks

Measured on a bench Worker with fake agents (`scripts/bench.mjs`) and scripted outside agents (`scripts/swarm.mjs`):

- Sharded claims: 200 agents at once in 61 s with none failing; exactly one of five racers wins a contested path at every level.

## Language support

Builders, reviewers and the checks run in Cloudflare's managed `cloudflare/debian-trixie` image, which has Node.js 24 and npm. On top of it, each container installs git and whichever toolchains the repo uses, read from its tracked files in any folder:

| Toolchain | Detected by | Installed | Dependencies |
|---|---|---|---|
| Python 3 | `pyproject.toml`, `requirements*.txt`, `setup.py`, `setup.cfg`, `uv.lock`, `Pipfile` | the system's `python3` and `uv`, with a virtualenv at `/opt/venv` | `uv sync` (or `uv pip install -r requirements*.txt`) |
| Go | `go.mod` | the latest release (`GOTOOLCHAIN` fetches a newer one a `go.mod` asks for) | `go mod download` |
| Rust | `Cargo.toml` | `rustup`, minimal profile with clippy and rustfmt (a `rust-toolchain.toml` is honoured) | `cargo fetch` |

The checks install dependencies before a repo's `verify` commands run, and skip that while the files they come from are unchanged. For Node, unless one of the checks installs (`npm ci`, `npm install`, or pnpm's or yarn's), a repo with a `package.json` gets `npm ci` from its npm lockfile, or `npm install` without one. A failed install fails the check, with its output. Toolchains install outside the checkout, so they survive between checks in a running container, and the repo's snapshot carries them to new ones. Other languages (Java, .NET, Ruby, Swift) aren't installed; iOS apps can't be built at all, since Xcode runs only on macOS.

## Run it

Requires a Cloudflare account on the Workers Paid plan (Artifacts is not available on Free) and Node 18+.

```sh
npm install
npx wrangler login
cp .dev.vars.example .dev.vars        # set OPENAI_API_KEY
npm run dev                           # real Artifacts service; containers disabled (they need Docker locally)
```

## Signing in

GitHive has two front doors:

- **The public address** (`PUBLIC_ORIGIN`: githive.app, or bench.githive.app for the bench). People sign in with GitHub or Google, by invitation for now. Agents connect over MCP with OAuth 2.1, or with an agent token.
- **The Cloudflare Access hostnames** (blueprint.nuandy.workers.dev and the bench's). These are for admins and scripts: a person or a service token that Access has verified. Invitations are managed here.

Every request resolves to one caller (`src/auth/principal.ts`): an Access identity, a signed-in person (session cookie), or an agent (a `ghv_` token, or an OAuth grant). A person is `person:<hash of their verified email>` in the records, whichever door they came in by. Their agents are `<handle>/<agent>`, signed as `person:<hash>/<handle>/<agent>`, so a grant to a pool (`person:<hash>/*`) covers all of a person's agents.

**Who may do what.** Repos are named `<owner>/<name>`, as on GitHub: the owner is a person (everyone has their own namespace, named for their handle) or an org. Orgs are optional and shared: owners, admins and members, invitations by email, and teams. A repo is private or public, and can have collaborators. What someone may do in a repo is read, review, write or admin:

| Needs | Routes and tools |
|---|---|
| read | the repo's pages, its code, `claims`, `status`, `check`, `audit`, `credentials` for the project |
| review | `next`, `review_access`, `vote` (and a person's vote on the dashboard) |
| write | `claim`, `release`, `credentials` for a change's fork, `merge`, `revert`, `add_work`, `ask_human`, `request_review`, `build` |
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

**Who gets in.** Only people an admin approves can sign in. An org's owners can invite anyone by email, but someone not yet approved waits: their email shows on the admin page (the dashboard's Admin page, through Access) as a request, and once it's approved they join the org when they first sign in. GitHive's hosted agents (`build`, `request_review`) run on GitHive's model account, so only the people an admin lists may start them.

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
| Live feeds, kept dashboard views, the repo list's counts, check containers' state | Durable Objects | AES-256 (LUKS) |
| A repo's snapshot: a container's disk with its code checked out and its main branch's dependencies installed, which check containers, builders and reviewers start from | Cloudflare Containers | Not documented by Containers |

Artifacts is in beta, and its own documentation doesn't yet state encryption at rest: the claim for repos rests on what it's built on. Ask Cloudflare for a direct statement, and whether Artifacts is in scope for its SOC 2 and ISO 27001 reports, before relying on it for compliance. Everything travels over TLS.

**What GitHive adds.**
- Secrets people and agents hold are never stored as given: session ids and agent tokens (`ghv_…`) are kept only as SHA-256 hashes, and an agent key registered in a repo only as its hash. (GitHive's own short-lived Artifacts tokens are cached in a Durable Object until they expire.)
- The OAuth provider encrypts each grant's details with a key derived from the token, which only the token's holder has.
- The records in Git name a person as `person:<the first 12 hex digits of a SHA-256 of their email>`, never the email. An email is stored only in D1, to sign people in.
- Records are signed (Ed25519) with a key only the Worker holds, so the audit can tell what went through GitHive from what was pushed around it.
- GitHive never puts a person's email or verified identity into its hosted agents' instructions. Those agents do read the repo they work on, and Git history can carry commit authors' names and emails.
- A repo someone can't see answers as if it didn't exist.

**Deleting a repo** deletes its code, history, records and its agents' forks at once. Its snapshot can't be deleted sooner than Containers allows: GitHive forgets it, so nothing starts from it again, and Containers drops it within 30 days.

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

- **Semantic conflicts.** Every push is checked for text conflicts; changes that merge cleanly but break together are caught by the checks on the merge line.
- **Scale.** 1000 agents at once claim, push, check and release in about 70 s with no failures (see the benchmark); past that is untested.

Planned mode (a planner splitting a feature into slices with contracts, approved by a human and landed as a whole) lives on the `plan-mode` branch. An earlier design with an elected coordinator is archived on the `elected-mode-archive` branch.

## License

MIT
