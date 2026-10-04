# Blueprint

A Git platform where agents split the work instead of duplicating it. Built on Cloudflare Workers and [Artifacts](https://developers.cloudflare.com/artifacts/).

- **Blueprint.** A planner breaks a feature into slices and commits the contracts between them (types, interfaces, failing tests) before anyone starts. Each slice gets its own Artifacts fork and builder agent, and owns a set of paths, so the agents work in parallel without waiting on each other.
- **Merge-ahead.** Every push test-merges the slice against the base and every other in-progress slice, so conflicts surface while the work is still in progress, not at merge time.
- **Quorum.** Specialist reviewer agents (security, tests, API by default) vote on the exact commit under review. A slice integrates only when the quorum approves, and veto roles can block it outright.

## How a task flows

```
POST /tasks                         repo + goal
POST /tasks/:id/plan                planner agent reads the repo and proposes a blueprint
PUT  /tasks/:id/blueprint           or propose one yourself: slices, owned paths, contracts, review policy
POST /tasks/:id/approve             forks <id>--base, commits contracts, forks one repo per slice
                                    -> returns write credentials for each builder agent
     builder pushes to its fork
POST /tasks/:id/slices/:s/pushed    Merge-ahead: touched paths, out-of-lane paths, pairwise checks
POST /tasks/:id/build               starts a hosted builder agent per slice
POST /tasks/:id/slices/:s/reviewers starts hosted reviewer agents (builders do this on finish)
POST /tasks/:id/slices/:s/review    or pins the head and returns read-only assignments for your own reviewers
POST /tasks/:id/slices/:s/reviews   a reviewer's verdict on the pinned head
POST /tasks/:id/slices/:s/integrate requires an approved quorum on the current head
POST /tasks/:id/land                merges the base into the project repo
```

The planner agent (OpenAI `gpt-6-luna`, via the Responses API) reads the repo through the Artifacts binding, with no clone, and finishes by calling a `submit_blueprint` tool. That tool applies the same validation as the Coordinator, then checks the contract files in a container against the project: TypeScript with the compiler (using each file's nearest `tsconfig.json`), plain JavaScript for syntax with `node --check`. Errors about modules that don't exist yet are expected and ignored. Any problems go back to the model to fix. Planning runs from a Durable Object alarm, so poll `GET /tasks/:id` until `planner.status` is `done` or `failed`.

`POST /tasks/:id/build` starts one hosted builder per slice: a `Builder` Durable Object with its own Linux container (the managed `cloudflare/debian-trixie` image, Node 24). A `gpt-6-luna` agent works on the slice's fork through tools (list, read, write, run a command, `commit_and_push`, `finish`). Every push runs Merge-ahead, and the agent gets the conflicts and lane violations back as the tool result. The fork's token is passed only on the git commands the Builder runs itself, so it never sits in the container's files or environment. Follow progress at `GET /tasks/:id/slices/:slice/builder`.

When a builder finishes, its slice goes to review. One `Reviewer` per role (the planner picks the roles, for example security, tests and api) checks out the exact commit under review in its own container, with a read-only token. It reads the diff, runs the slice's acceptance tests, and calls `submit_verdict` with evidence. The vote goes to the slice's Quorum, and a vote on a commit that has since moved is rejected as stale. Follow reviewers at `GET /tasks/:id/slices/:slice/reviewers`.

What happens after a vote is automatic:

- **Approved:** the slice goes through the **integration gate** (semantic Merge-ahead). A `Gate` container merges the slice onto the current task base and runs the task's `verify` commands, which the planner picks from the repo's scripts (for example `npm ci`, `npm test`, `npm run typecheck`). Contract tests that belong only to slices not yet integrated are left out, since they can't pass yet. A pass integrates the slice. Slices checked together as a group integrate together: their merges are made in one checkout and pushed once, so the base gets the whole group or none of it. A failure goes back to the builder with the failing output, like a rejection, and the builder fixes it in its lane or proposes a contract amendment. If another slice integrates while a gate runs, the result is discarded and the gate re-runs on the new base. Tasks without `verify` commands integrate on approval.
- **Rejected or vetoed:** the rejecting reviewers' findings and evidence go back to the slice's builder. The builder resumes the same conversation in a fresh container, fixes the problems, pushes and finishes, which starts a new review. The slice's other reviewers are cancelled, since their votes would be on a stale commit. After 3 revisions, the slice is flagged for a human (`attention` on the slice).

**Contract amendments.** Contracts are frozen for builders, but a contract can turn out to be wrong, or to contradict a review finding. A builder can then call `propose_contract_change` with the new file content and its reason. It can also propose a *new* contract file outside every lane, such as a test its slice should be held to that its lane can't contain; an approved new test joins the slice's acceptance tests. And it can propose a change to a project file outside every lane that slices share, such as a list of routes each slice registers in: approval brings that file under contract. Lanes themselves never change. A proposal is the whole file and names the version it started from; if the base has a different version, when proposed or when about to be committed, it is refused as stale, so one slice's change can't overwrite another's. The builder merges the base and proposes again on top. A contract owner agent weighs the change against the task goal and every slice's lane and tests, and approves or rejects it with a reason. An approved change is committed to the task base: the proposer merges it with `fetch_base`, and other slices' running builders are told to do the same. Reviewers judge slices against the amended contracts. Every amendment is recorded in `task.amendments`. If a slice is sent back and its builder finishes without a new commit, it is flagged for a human instead of being reviewed again.

**Limits and queues.** Each task has `limits` for how many builders and reviewers run at once (defaults 4 and 6; set them with `POST /tasks`). Work beyond the limit waits in the task's queue and starts as agents stop; queued work that goes stale, such as reviewers for a commit that was sent back, is dropped. Revisions start right away, since a slice in revision blocks integration. Gates run one slice at a time per task, in a container that stays warm: each run checks against the base as it is when the run starts, and `npm ci` is skipped while `package-lock.json` is unchanged.

**Human decisions.** `POST /tasks/:id/slices/:slice/message` sends a builder a message: a running builder reads it at its next turn, and a stopped one resumes its conversation with it. A builder that stops (for example, at its turn limit) flags its slice for a human. A slice flagged for a human can also be let through with `POST /tasks/:id/slices/:slice/waive` and a reason: the waiver is recorded on the slice, and the integration gate still runs. `POST /tasks/:id/slices/:slice/gate` re-runs the gate for an approved slice, for example after fixing the task base by hand.

Landing the finished task on the project repo stays a manual step: `POST /tasks/:id/land`.

Each slice lists the contract tests it must make pass. Builders and reviewers run those, because another slice's contract tests can fail until that slice is integrated.

**The record in Git.** Every decision is written to the project repo, on the notes ref `refs/notes/blueprint/<task>`. Each decision is a note on the commit it is about: a vote on the reviewed commit, a gate result on the gated one, a contract change on the commit that applied it. `git log --notes=blueprint/<task>` reads as the task's audit trail, with no dashboard or API needed. Each notes commit also carries a JSON merge patch of the task's state, so replaying the notes ref rebuilds the task exactly. `GET /tasks/:id/ledger` replays it and compares the result with the Coordinator's copy. `POST /tasks/:id/restore {repo}` recreates a task from Git into an empty Coordinator. If Git can't be reached, decisions are kept and written with the next change.

```
$ git fetch origin 'refs/notes/blueprint/*:refs/notes/blueprint/*'
$ git log --notes=blueprint/a9338368 -1
commit a2bb21f…  Add hello
Notes (blueprint/a9338368):
    2026-10-02 13:24:15Z  hello pushed a2bb21f5: 1 file changed; Merge-ahead: no conflicts
    2026-10-02 13:24:22Z  hello: tests reviewer approved: README present; nothing else changed
    2026-10-02 13:24:22Z  hello: quorum approved
    2026-10-02 13:24:26Z  hello integrated into the task base
```

One `Coordinator` Durable Object per task holds its state and runs every Git write. Its state is a cache of the record in Git. The Artifacts binding creates, forks and reads repos. Commits, merges and pushes go through [isomorphic-git](https://isomorphic-git.org/) on an in-memory filesystem, because the binding can't write inside a repo.

## Language support

Blueprint works on **JavaScript and TypeScript projects** today. Builders, reviewers, the integration gate and the contract check all run in Cloudflare's managed `cloudflare/debian-trixie` image, which has Node.js 24 and npm (git is installed at startup), but no Python, Go or other toolchains.

- **Contract check:** TypeScript files are type-checked and plain JavaScript files are syntax-checked. Files in other languages, and JSX, are listed as not checked; planning still goes ahead.
- **Integration gate:** runs whatever `verify` commands the planner picks, so it isn't tied to a language, but commands like `pytest` or `go test` fail without their toolchain.
- **Other languages** would need their toolchain installed when a container starts (or a custom image), plus a matching contract check such as `python -m py_compile` or `go vet`.

## Run it

Requires a Cloudflare account on the Workers Paid plan (Artifacts is not available on Free) and Node 18+.

```sh
npm install
npx wrangler login
npx wrangler queues create blueprint-events
cp .dev.vars.example .dev.vars        # set OPENAI_API_KEY
npm run dev                           # real Artifacts service; builder containers disabled (they need Docker locally)
```

The Access team domain and application audience are public configuration in `wrangler.jsonc`. There is no local-development authentication bypass: the Worker rejects requests without a valid, signed `Cf-Access-Jwt-Assertion`, including requests to `wrangler dev`. A service token's client ID and secret are credentials for the Cloudflare Access edge; they do not replace the signed assertion when calling the Worker directly. For authenticated manual requests, use the deployed hostname protected by the Access application.

People can use the dashboard after signing in through Cloudflare Access. Scripts should be authorized by an Access service-token policy for the application. This lists the project repos:

```sh
export CF_ACCESS_CLIENT_ID='your-service-token-client-id'
export CF_ACCESS_CLIENT_SECRET='your-service-token-client-secret'
curl https://blueprint.nuandy.workers.dev/repos \
  -H "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID" \
  -H "CF-Access-Client-Secret: $CF_ACCESS_CLIENT_SECRET"
```

The Access edge validates those service-token headers and supplies the assertion that the Worker verifies. Do not send an `Authorization: Bearer` API token; Blueprint no longer uses `API_TOKEN`.

Deploy (the Access variables are already in `wrangler.jsonc`):

```sh
npx wrangler secret put OPENAI_API_KEY
npm run deploy
```

## Develop

```sh
npm test            # unit tests
npm run typecheck
npm run types       # regenerate worker-configuration.d.ts after editing wrangler.jsonc
```

## Known gaps

- **Push events.** Artifacts `pushed` events are per-repo subscriptions, so forks created at runtime aren't covered by a static subscription. For now, builders report pushes via `POST .../pushed`. The queue consumer handles any repo that does have a subscription.
- **Semantic conflicts during the build.** Every push is checked for text conflicts; changes that merge cleanly but break together are caught at the integration gate, not while slices are still being built.

## License

MIT
