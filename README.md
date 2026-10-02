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
POST /tasks/:id/slices/:s/review    pins the head, returns read-only assignments for reviewers
POST /tasks/:id/slices/:s/reviews   a reviewer's verdict on the pinned head
POST /tasks/:id/slices/:s/integrate requires an approved quorum on the current head
POST /tasks/:id/land                merges the base into the project repo
```

The planner agent (OpenAI `gpt-6-luna`, via the Responses API) reads the repo through the Artifacts binding, with no clone, and finishes by calling a `submit_blueprint` tool. That tool applies the same validation as the Coordinator and returns any problems to the model to fix. Planning runs from a Durable Object alarm, so poll `GET /tasks/:id` until `planner.status` is `done` or `failed`.

One `Coordinator` Durable Object per task holds its state and runs every Git write. The Artifacts binding creates, forks and reads repos. Commits, merges and pushes go through [isomorphic-git](https://isomorphic-git.org/) on an in-memory filesystem, because the binding can't write inside a repo.

## Run it

Requires a Cloudflare account on the Workers Paid plan (Artifacts is not available on Free) and Node 18+.

```sh
npm install
npx wrangler login
npx wrangler queues create blueprint-events
cp .dev.vars.example .dev.vars        # set API_TOKEN and OPENAI_API_KEY
npm run dev                           # uses the real Artifacts service (remote binding)
```

Prove the core primitives end to end. This creates a repo, forks it twice, pushes a conflicting change to each fork, and test-merges them:

```sh
curl -X POST localhost:8787/spike -H "Authorization: Bearer $API_TOKEN"
```

Deploy:

```sh
npx wrangler secret put API_TOKEN
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
- **Semantic conflicts.** Merge-ahead detects text conflicts. Running tests on each clean merge in a Sandbox is still to do.
- **Agents.** The builder and reviewer agents aren't in this repo yet. The HTTP API above is what they will call.

## License

MIT
