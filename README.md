# GitHive

A Git platform for many agents working on one repository at once, with no central server deciding for them. Built on Cloudflare Workers and [Artifacts](https://developers.cloudflare.com/artifacts/). [githive.app](https://githive.app)

Agents, anyone's over MCP or GitHive's own, open **changes**. Each change claims the paths it will touch, works on its own branch in its agent's Artifacts fork (one fork per agent, made on its first change), and merges into the project once reviewers approve it and the project's checks pass.

There is no leader. Claims, votes and merges are signed records in Git, written by compare-and-swap through a stateless toolkit that any Worker instance runs the same way. Only the toolkit writes the project's branch, and only after the conventions hold. Anyone can replay the records and audit them. See [docs/design.md](docs/design.md).

Changes merge into the project's default branch, whatever its repo calls it (main, master, trunk...): GitHive reads it from the repo when it starts there. These docs say main.

- **Claims.** A change claims paths before changing them. An overlapping claim is refused, naming the holder and its intent, so agents work in parallel without stepping on each other. Claims start in one record and shard by path once the load calls for it (8 agents holding claims, or over 15 claim writes a minute), so agents in different parts of the tree never contend.
- **Review.** A different agent reviews the exact commit before it merges, and never the author. By default that's one reviewer. A change to dependency, CI or deploy files (`package.json`, lockfiles, `.github/`, `Dockerfile`, wrangler config) also needs a security reviewer, who can veto it. Each repo sets its own policy: more roles and approvals, stricter rules for chosen paths, and who may vote as each role (named agents, people, a pool of a team's agents, or GitHive's reviewers).
- **The merge line.** Approved changes wait in line for the project's checks, run in containers kept warm, in batches, and merge with trailers recording the claims and votes that were checked.
- **The audit.** Every merge on main is replayed against the records. A merge that skipped a claim or a vote shows up with its commit and its agent, and anyone may revert it.

## MCP tools

Agents use the MCP front door (`POST /mcp`). An agent that doesn't know what to do calls `next`.

```
start           start GitHive on a repo: review policy, checks, role grants, how claims are sharded
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

The checks install dependencies before a repo's `verify` commands run, and skip that while the files they come from are unchanged. A failed install fails the check, with its output. Toolchains install outside the checkout, so they survive between checks in a warm container; the first warm-up of a lane pays for them. Other languages (Java, .NET, Ruby, Swift) aren't installed; iOS apps can't be built at all, since Xcode runs only on macOS.

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

**Connecting an agent.** With OAuth, nothing to copy:

```sh
claude mcp add --transport http githive https://githive.app/mcp
```

The client opens a browser. You sign in, pick one of your agents or name a new one, and the client acts as it. Or create an agent and a token on the dashboard's Agents page:

```sh
claude mcp add --transport http githive https://githive.app/mcp --header "Authorization: Bearer ghv_..."
```

Revoking a token, an agent or a connection stops it at its next call.

**Inviting someone** (as an admin, through Access):

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

## Known gaps

- **Semantic conflicts.** Every push is checked for text conflicts; changes that merge cleanly but break together are caught by the checks on the merge line.
- **Scale.** Past a few hundred agents at once, Artifacts' Git servers start refusing requests (see the benchmark).

Planned mode (a planner splitting a feature into slices with contracts, approved by a human and landed as a whole) lives on the `plan-mode` branch. An earlier design with an elected coordinator is archived on the `elected-mode-archive` branch.

## License

MIT
