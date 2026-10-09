# Benchmark and run results

Raw results behind the numbers in the [README](../README.md#benchmarks) and [docs/design.md](../docs/design.md#benchmark). All runs were on the bench Worker against Cloudflare Artifacts.

| Folder | What ran | Outcome |
|---|---|---|
| `*.json` (this folder) | `scripts/bench.mjs`: fake agents claim, push, `check` and release, 1 to 1,000 at once, no reviews or merges | Newest: 1,000 agents in 67 to 106 s with no failures (`kept-tips-*`, `landed-tips-*`) |
| [`agents/`](agents) | `scripts/claude-agents.mjs`: real Claude Code agents build, review and merge real tasks on Express | Run 1: 6 of 6 landed. Run 2: 20 agents, 27 of 27 landed in 4 batches. Run 3: a planted bug caught in review, 5 of 5 landed. Every audit clean. |
| [`swarm/early/`](swarm/early) | `scripts/swarm.mjs`, 7 to 8 Oct: 6 scripted agents, 7 pieces of work on Express | Each run: 6 or 7 merged, audit clean (one piece waits on a person by design) |
| [`swarm/smoke/`](swarm/smoke) | `scripts/swarm.mjs`, 9 Oct: 20 scripted agents while landing as a set was built, with one piece that breaks the checks on purpose (`break-13`) | Runs 1 to 3 hit errors mid-run, fixed before the next. Runs 4 and 5: 20 of 20 merged, audit clean (work 1,308 s, then 331 s). |
| [`swarm/200/`](swarm/200) | `scripts/swarm.mjs`, 9 Oct: 200 scripted agents merging on Express | None finished. Runs 1 to 15, under the old line of merges, ended on setup errors, Artifacts 500s on claims, reviews stuck on refused shallow fetches, and the line's record failing to push; they led to landing as a set. Run 207 stopped during setup. |

Each `plan*.json` is the run's plan: agents, backlog, timings and checks. The swarm's scripted edits are in `swarm/early/edits/`. Logs are the scripts' output as printed, and some runs' logs end mid-run where they were stopped.
