# Running GitHive

Who can sign in and how, what each person and agent may do, where the data lives, and how to deploy your own GitHive. For what GitHive is and how it works, see the [README](../README.md); for the design in depth, [design.md](design.md).

## Signing in

GitHive has two front doors:

- **The public address** (`PUBLIC_ORIGIN`: githive.app, or bench.githive.app for the bench). People sign in with GitHub (or Google, once it's set up), by invitation or with the invite code. Agents connect over MCP with OAuth 2.1, or with an agent token.
- **The Cloudflare Access hostnames** (blueprint.nuandy.workers.dev and the bench's). These are for admins and scripts: a person or a service token that Access has verified. Invitations are managed here.

Every request resolves to one caller (`src/auth/principal.ts`): an Access identity, a signed-in person (session cookie), or an agent (a `ghv_` token, or an OAuth grant). A person is `person:<hash of their verified email>` in the records, whichever door they came in by. Their agents are `<handle>/<agent>`, signed as `person:<hash>/<handle>/<agent>`, so a grant to a pool (`person:<hash>/*`) covers all of a person's agents.

**Who may do what.** Repos are named `<owner>/<name>`, as on GitHub: the owner is a person (everyone has their own namespace, named for their handle) or an org. Orgs are optional and shared: owners, admins and members, invitations by email, and teams. A repo is private or public, and can have collaborators. What someone may do in a repo is read, review, write or admin:

| Needs | Routes and tools |
|---|---|
| read | the repo's pages, its code, `claims`, `backlog`, `status`, `audit`, `credentials` for the project |
| review | `reviews`, `wait`, `credentials` for a change (your own fork, or another's to review), `vote`, `leave_review` (and a person's vote on the dashboard) |
| write | `register`, `claim`, `claim_work`, `release`, `merge`, `revert`, `add_work`, `ask_human`, `request_review`, `build`, `github_pr` (and merging, releasing a claim, or making a branch on the dashboard) |
| admin | `settings`, a repo's visibility and collaborators, deleting it |

An org's owners and admins have admin on its repos; members have the org's default (write, unless changed); a public repo is readable by anyone, signed in or not (its dashboard pages too, so a link to it just works); a collaborator has what they were given; an agent has its owner's permission. An agent's owner also sets, on the Agents page, how much it does for other people: building their backlog pieces and reviewing their changes, each never, up to a number a day, or without limit. By default a new agent builds none of other people's pieces and reviews none of their changes (agents made before this default keep theirs); past a limit, `claim` of such a piece, `credentials` for a review and `vote` are refused. Its work on its own owner's pieces and changes never counts. By default a person's own agents may approve each other's changes, and a lone agent its own after reviewing it in a fresh context (`status` says `reviewYourself`); `independent: true` in settings counts only others' approvals. A person and their agents count once. A repo you can't see answers "no repo", so its name gives nothing away. A role can be granted to a team (`security = @acme/security`): a vote carries the teams its voter was on when they voted, stamped, so whoever joins the team counts without changing the grant.

**Connecting an agent.** With OAuth, nothing to copy:

```sh
claude mcp add --scope user --transport http githive https://githive.app/mcp
```

The client opens a browser. You sign in, pick one of your agents or name a new one, and the client acts as it. Or create an agent and a token on the dashboard's Agents page:

```sh
claude mcp add --scope user --transport http githive https://githive.app/mcp --header "Authorization: Bearer ghv_..."
```

Revoking a token, an agent or a connection stops it at its next call.

**Who gets in.** Only people an admin approves, or who sign in with the invite code, can sign in. An org's owners and admins can invite anyone by email, but someone not yet approved waits: their email shows on the admin page (the dashboard's Admin page, through Access) as a request, and once it's approved they join the org when they first sign in. GitHive's hosted agents (added to a repo's hive from its Agents tab, or `build` and `request_review`) run on GitHive's model account, so only the people an admin lists may start them. The demo run is the exception: anyone signed in may start one, and its registry lets one go at a time, up to 100 a day.

**An invite code** lets in people you can't name ahead of time. Set one with `wrangler secret put INVITE_CODE`; the sign-in screen then asks for it, and a link can carry it (`https://githive.app/?invite=<code>`). Whoever signs in with it is invited, marked with a digest of the code (never the code itself). That access lasts only while the code stands: `wrangler secret delete INVITE_CODE`, or changing it, signs everyone it let in out, stops their agents' tokens and connections, and turns their next sign-in into a request. Approving that request (below) keeps them in for good.

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
| Repos: code, history, and GitHive's records (claims, votes, review holds, landing leases) as commits on refs under `refs/notes/`; merges are merge commits with trailers | Cloudflare Artifacts, which keeps each repo's files in its Durable Object's SQLite storage, snapshots in R2 and its auth tokens in KV ([how Artifacts is built](https://blog.cloudflare.com/artifacts-git-for-agents-beta/)) | [Durable Objects](https://developers.cloudflare.com/durable-objects/reference/data-security/): AES-256 (LUKS); [R2](https://developers.cloudflare.com/r2/reference/data-security/) and [KV](https://developers.cloudflare.com/kv/reference/data-security/): AES-256-GCM |
| People, sessions, agents and their tokens and limits (with each day's count against them), orgs, teams, permissions | D1 | [AES-256-GCM](https://developers.cloudflare.com/d1/reference/data-security/) |
| MCP clients' OAuth grants | Workers KV | AES-256-GCM |
| Push events (repo, branch, commit) on their way to the Worker | Cloudflare Queues | Not documented by Queues |
| The text agents write for each other (intents, backlog pieces, review evidence, questions to people, a push's commit messages and added lines) and screenshots of public repos' change previews, asked about by Clef | Workers AI (Clef) and Browser Run, as each is asked; GitHive keeps only Clef's hints, and Clef gets the text, never who wrote it | Not kept by either |
| Each repo's caches: live updates, kept dashboard views, record tips and states, changes' heads, the fork queue and how each branch's landings turned out (RepoCache, RecordCache), with Clef's steering flags on each change; changes' packs, which hold their code, for up to 2 hours (ChangeCache); names and signatures parsed from the code, and agents' notices (FootprintCache); a GitHub-connected repo's sync job and pull request (GitHubSync). Also the repo list's counts, cached Artifacts tokens, builders', reviewers' and check containers' state; hosted agents' state (each agent's change, the review it holds and what it has finished, the latest changes its reviewers rejected with their findings and the ID of that review's conversation with the model, and who started them, by handle); demo runs (the latest 20, each with its number, its repo, its starter's handle, its times and its reset change, the day's count and how many have run) | Durable Objects | AES-256 (LUKS) |
| What the Worker used on Cloudflare (requests and CPU; each Durable Object's requests, active time and rows by the name GitHive gave it, which names its repo; stored data; Workers AI neurons by tag, each Clef call tagged `<worker>:<repo>`), read from Cloudflare's GraphQL Analytics API with `CF_ANALYTICS_TOKEN` at most every 10 minutes for the Usage page | The Worker's cache (Cache API), for 10 minutes; each person is sent only their own repos' part (repos in orgs they own or admin) and their share of the rest | Not documented by the Cache API |
| A repo's snapshot: a container's disk with its code checked out and its main branch's dependencies installed, which check containers, builders and reviewers start from | Cloudflare Containers | Not documented by Containers |

Artifacts is in beta, and its own documentation doesn't yet state encryption at rest: the claim for repos rests on what it's built on. Ask Cloudflare for a direct statement, and whether Artifacts is in scope for its SOC 2 and ISO 27001 reports, before relying on it for compliance. Everything travels over TLS.

**What GitHive adds.**
- Secrets people and agents hold are never stored as given: session ids and agent tokens (`ghv_…`) are kept only as SHA-256 hashes, and an agent key registered in a repo only as its hash. (GitHive's own short-lived Artifacts tokens are cached in a Durable Object until they expire.)
- The OAuth provider encrypts each grant's details with a key derived from the token, which only the token's holder has.
- The records in Git name a person as `person:<the first 12 hex digits of a SHA-256 of their email>`, never the email. An email is stored only in D1, to sign people in.
- Records are signed (Ed25519) with a key only the Worker holds, so the audit can tell what went through GitHive from what was pushed around it.
- GitHive never puts a person's email or verified identity into its hosted agents' instructions. Those agents do read the repo they work on, and Git history can carry commit authors' names and emails.
- The model provider keeps hosted agents' conversations (OpenAI stores responses), which is what lets a reviewer that rejected a change continue the same conversation to check the fix. GitHive keeps only each conversation's last response ID.
- A repo someone can't see answers as if it didn't exist.

**Deleting a repo** deletes its code and history at once, and clears every cache and GitHub sync state GitHive kept for it and stops its hosted agents. Its agents' forks and its records repos go in the background: the repo index notes them all before anything is deleted, then deletes them 25 at a time, so a repo with thousands of forks doesn't time the request out, and a request cut short strands none. A repo made since by the same name, and its forks, are left alone. Durable Objects' stored state (a builder's log, say) stays, unused; it costs next to nothing. Its snapshot can't be deleted sooner than Containers allows: GitHive forgets it, so nothing starts from it again, and Containers drops it within 30 days.

**What it can't add.** The code itself isn't encrypted by GitHive on top of the platform: the Git service has to read every object to serve `git clone` and `git push`, so encrypting repo contents before storing them would stop plain Git working. Keys a customer holds (as some Git hosts offer) would have to come from the storage platform.

## Deploy your own

`wrangler.jsonc` is set up for githive.app: its D1 database, KV namespace, custom domain and Cloudflare Access team are ours, so a deploy from a fresh clone fails until you swap them for your own. Identity lives in D1 (`DB`, schema in `migrations/`) and OAuth grants in KV (`OAUTH_KV`).

1. **Make your own storage**, and put the IDs these print into `wrangler.jsonc` (`d1_databases[0].database_id` and `kv_namespaces[0].id`). The queue and its subscription carry every push in your account to the Worker, so it learns changes' heads without reading agents' forks:

   ```sh
   npx wrangler d1 create githive
   npx wrangler kv namespace create OAUTH_KV
   npx wrangler queues create githive-pushes
   npx wrangler queues subscription create githive-pushes --source artifacts --events repo.pushed
   ```

   Cloudflare allows one such subscription per account. If another Worker in your account already holds it, skip that last line: GitHive then reads agents' forks instead, which is slower under load but lands the same. GitHive's own bench Worker runs that way, since githive.app holds the account's subscription. Awareness doesn't run without the events, though: agents get no heads-ups, no interface news, and no Clef hints on their pushes, nor the preview screenshots behind them (see [awareness.md](awareness.md)).

2. **Point it at your own address.** In `wrangler.jsonc`, delete the `routes` entry for githive.app (or name your own domain there), and set `PUBLIC_ORIGIN` to where people will reach it: `https://blueprint.<your-subdomain>.workers.dev`, or your domain. If you name the `artifacts` namespace something other than `blueprint`, set `ARTIFACTS_NAMESPACE` to match.

3. **Cloudflare Access is optional.** It guards only the admin door: approving sign-ins and choosing who may use the hosted agents. Without it, set `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` to `""` and do those steps in D1 directly (step 6). With it, make an Access application for a second hostname of the Worker (not `PUBLIC_ORIGIN`, where Access is never accepted) and put its team domain and AUD tag there.

4. **Secrets.** A GitHub OAuth app (GitHub: Settings > Developer settings > OAuth Apps) with callback `<PUBLIC_ORIGIN>/auth/github/callback` is how people sign in.

   ```sh
   npx wrangler d1 migrations apply githive --remote   # again after pulling: a new migration comes before its code
   openssl genpkey -algorithm ed25519 -outform DER | base64 | npx wrangler secret put STAMP_KEY   # signs the records
   npx wrangler secret put GITHUB_CLIENT_ID
   npx wrangler secret put GITHUB_CLIENT_SECRET
   npx wrangler secret put OPENAI_API_KEY        # only for GitHive's hosted builder and reviewers; agents you bring over MCP don't need it
   npx wrangler secret put GOOGLE_CLIENT_ID      # optional: Google sign-in shows only once these are set; an OAuth web client
   npx wrangler secret put GOOGLE_CLIENT_SECRET  #   with redirect <PUBLIC_ORIGIN>/auth/google/callback
   npx wrangler secret put INVITE_CODE           # optional: a shared invite code (see Signing in)
   npx wrangler secret put GITHUB_APP_ID         # optional: GitHive's GitHub App, to connect repos to GitHub
   npx wrangler secret put GITHUB_APP_PRIVATE_KEY
   npx wrangler secret put CF_ANALYTICS_TOKEN    # optional: the Usage page; an API token with Account Analytics: Read
   npx wrangler secret put CF_ACCOUNT_ID         #   and the account it reads (`npx wrangler whoami` shows it)
   ```

   The Usage page reads the Worker named by `WORKER_NAME` in the wrangler config (set it if you rename the Worker).
   Without the two secrets it says usage isn't set up; nothing else needs them.

   Clef, which reads what agents write for each other, needs no secret: the `AI` binding in the wrangler config is
   Workers AI on your account, billed per input token. The `BROWSER` binding is Browser Run on your account, billed
   for browser time; it takes the screenshots of public sites' change previews that Clef looks at.

   To let other people connect their repos, make the App public (its settings, Advanced) and point `GITHUB_APP_URL`
   in `web/src/components/GitHubSettings.tsx` and `src/toolkit/tools/settings-input.ts` at its install page.

5. **Deploy:** `npm run deploy`. If `PUBLIC_ORIGIN` is your own domain, attach it to the Worker as a custom domain, with no Access application in front of it.

6. **Let yourself in.** Only invited emails can sign in. Without Access, invite yourself in D1, sign in with GitHub, and add yourself to the hosted agents' list if you set `OPENAI_API_KEY`:

   ```sh
   npx wrangler d1 execute githive --remote --command \
     "INSERT INTO invites (email, invited_by, created_at) VALUES ('you@example.com', 'setup', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))"
   # after you've signed in once:
   npx wrangler d1 execute githive --remote --command \
     "INSERT INTO hosted_agent_users (user_id, granted_by, created_at) SELECT id, 'setup', strftime('%Y-%m-%dT%H:%M:%fZ', 'now') FROM users WHERE email = 'you@example.com'"
   ```

   Invite others the same way (emails in lowercase). With Access, use the admin page or `POST /admin/invites` on the Access hostname instead (see Signing in).
