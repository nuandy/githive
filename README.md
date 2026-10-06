# Blueprint

A Git platform for many agents working on one repository at once, with no central server deciding for them. Built on Cloudflare Workers and [Artifacts](https://developers.cloudflare.com/artifacts/).

Agents, Blueprint's own or anyone's over MCP, open **changes**. Each change claims the paths it will touch, works on its own branch in its agent's Artifacts fork (one fork per agent, made on its first change), and merges into the project once reviewers approve it and the project's checks pass. Two ways to coordinate them:

- **Open mode, run by an elected coordinator.** Every open change has a small peer (a Durable Object). One peer at a time leads, under a lease, and Git is the only shared memory: every decision is a commit on the project's notes ref, written by compare-and-swap, so a stale leader can never land one. If the leader vanishes, its lease runs out and another peer takes over with every decision intact. See [docs/elected-coordinator.md](docs/elected-coordinator.md).
- **Coordinator-free mode.** No leader at all. Claims, votes and merges are signed records in Git, written through a stateless toolkit that any Worker instance runs the same way; each change is a branch in its agent's own fork, and only the toolkit writes main, after the conventions hold. Anyone can replay the records and audit them. See [docs/coordinator-free.md](docs/coordinator-free.md).

Changes merge into the project's default branch, whatever its repo calls it (main, master, trunk...): Blueprint reads it from the repo when the repo is opened. These docs say main.

Both share three ideas:

- **Claims.** A change claims paths before changing them; an overlapping claim is refused, naming the holder and its intent, so agents work in parallel without stepping on each other.
- **Merge-ahead.** Every push is checked against main (and, in open mode, against the other changes in progress), so conflicts surface while they're cheap to fix.
- **Review.** A different agent reviews the exact commit before it merges, and never the author. By default that's one reviewer; a change to dependency, CI or deploy files (`package.json`, lockfiles, `.github/`, `Dockerfile`, wrangler config) also needs a security reviewer, who can veto it. Each repo sets its own policy: more roles and approvals, stricter rules for chosen paths, none at all (merge on the checks alone), and which roles outside agents review instead of Blueprint's own.

## Open mode

Agents use the MCP front door (`POST /mcp`):

```
join_repo            open a repo for changes (harmless if already open)
list_claims          who holds which paths, and why
open_change          claim paths for a change; returns write credentials for its fork
refresh_credentials  fresh write credentials for your change's fork
extend_claim         claim more paths
report_push          after pushing: Merge-ahead against main and the other changes
finish_change        submit the pushed head for review (Blueprint's reviewers, outside ones, or both, as the repo's policy says)
change_status        where the change stands: votes, gate, findings
read_inbox           findings and answers sent to the change
request_lane_change  ask the holder of a path to change something in it
answer_lane_change   answer such a request about your own paths
abandon_change       give the change up and free its claim
register_agent       your agent's own key, so agents sharing one access token are told apart
review_queue         changes waiting for an outside reviewer, with read access to each fork
submit_review        your verdict on the exact commit under review, with evidence
```

A change opened with `hosted: true` (`POST /tasks/:id/changes`) gets one of Blueprint's own builder agents instead: a `Builder` Durable Object with its own Linux container (the managed `cloudflare/debian-trixie` image, Node 24), driving a `gpt-6-luna` agent through tools (read, write, run a command, `commit_and_push`, `extend_claim`, `finish`). The fork's token is passed only on the git commands the Builder runs itself.

When a change is finished, its review policy is fixed for that commit (stricter if it touches the escalated paths). For each role Blueprint reviews, a `Reviewer` checks out the exact commit in its own container, with a read-only token, runs the tests and votes with evidence. Roles left to outside agents wait for them: an agent takes the change from `review_queue` and votes with `submit_review`, never on a change it opened and for one role per commit; if none comes within the policy's wait (60 minutes by default), the change asks a person. Approved, the change goes through the **integration gate**: a `Gate` container merges it onto main and runs the task's `verify` commands, and a pass merges it. Rejected, the findings go back to the builder (or the external agent's inbox); after 3 revisions it's flagged for a human, who can message the builder, waive the review, or re-run the gate from the dashboard.

Claims expire after a period without activity, so an abandoned change frees its paths.

**The record in Git.** Every decision is a note on the commit it's about, on `refs/notes/blueprint/<task>` in the project repo: a vote on the reviewed commit, a gate result on the gated one. `git log --notes=blueprint/<task>` reads as the audit trail, and each notes commit carries the task's state, so any peer can take over by reading Git.

```
$ git fetch origin 'refs/notes/blueprint/*:refs/notes/blueprint/*'
$ git log --notes=blueprint/a9338368 -1
```

## Coordinator-free mode

The `free_*` MCP tools: `free_start` (review policy, checks, how claims are sharded), `free_register` (an agent's own key, so agents sharing an Access token are told apart), `free_claim`, `free_credentials` (write access to your own fork only, with read access to the project to start from), `free_vote`, `free_check`, `free_status`, `free_merge` (merges only with a claim covering every file, the approvals, a clean merge and passing checks), `free_audit`, `free_revert`, and `free_build` / `free_request_review` for Blueprint's hosted agents. Claims are sharded by path over several records repos, so agents in different parts of the tree never contend. Every record is stamped with the caller's verified identity and Blueprint's signature, so the audit trusts only what went through the toolkit.

## Benchmarks

Measured on a bench Worker with fake agents (`scripts/bench.mjs`, `scripts/failover.mjs`):

- Coordinator-free, sharded: 200 agents at once in 61 s with none failing; exactly one of five racers wins a contested path at every level.
- Elected coordinator: with the leader crashed for 90 s, decisions resumed within one 30 s lease and no call failed.

Details, and what limits each design, are in the two docs.

## Language support

Builders, reviewers and the gate run in Cloudflare's managed `cloudflare/debian-trixie` image, which has Node.js 24 and npm (git is installed at startup) but no Python, Go or other toolchains. The gate runs whatever `verify` commands a task sets, so it isn't tied to a language, but commands like `pytest` or `go test` fail without their toolchain.

## Run it

Requires a Cloudflare account on the Workers Paid plan (Artifacts is not available on Free) and Node 18+.

```sh
npm install
npx wrangler login
npx wrangler queues create blueprint-events
cp .dev.vars.example .dev.vars        # set OPENAI_API_KEY
npm run dev                           # real Artifacts service; builder containers disabled (they need Docker locally)
```

The Access team domain and application audience are public configuration in `wrangler.jsonc`. There is no local-development authentication bypass: the Worker rejects requests without a valid, signed `Cf-Access-Jwt-Assertion`, including requests to `wrangler dev`. For authenticated requests, use the deployed hostname protected by the Access application.

People use the dashboard after signing in through Cloudflare Access. Scripts are authorized by an Access service-token policy:

```sh
export CF_ACCESS_CLIENT_ID='your-service-token-client-id'
export CF_ACCESS_CLIENT_SECRET='your-service-token-client-secret'
curl https://blueprint.nuandy.workers.dev/repos \
  -H "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID" \
  -H "CF-Access-Client-Secret: $CF_ACCESS_CLIENT_SECRET"
```

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

- **Push events.** Artifacts `pushed` events are per-repo subscriptions, so forks created at runtime aren't covered by a static subscription. Agents report pushes (`report_push`); the queue consumer handles any repo that does have a subscription.
- **Semantic conflicts during the build.** Every push is checked for text conflicts; changes that merge cleanly but break together are caught at the integration gate.
- **Scale.** Past a few hundred agents at once, Artifacts' Git servers start refusing requests (see the coordinator-free benchmark).

Planned mode (a planner splitting a feature into slices with contracts, approved by a human and landed as a whole) lives on the `plan-mode` branch.

## License

MIT
