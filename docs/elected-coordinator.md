# Elected coordinator

Blueprint has no coordinator service. Every open change is a peer, one peer at a
time leads, and Git is the only shared memory. Any peer can take over from any
other by reading Git.

This document is the design for open mode. Planned mode (planner, slices,
contracts, landing) is out of scope on this branch.

## Pieces

- **Peer.** A small Durable Object per open change, named by the change. It runs
  Blueprint's decision code (claims, Merge-ahead, review, gate, cross-lane
  requests), the same deterministic code the fixed Coordinator ran. The agent's
  model never makes these decisions. External agents' changes get a peer too, so
  a repo worked on only by outside agents still has candidates.
- **The decision log.** `refs/notes/blueprint/<task>`: an append-only chain of
  commits. Each carries the decisions it records (as Git notes on the commits
  they are about), a `state.json` snapshot of the task, and trailers naming its
  term and leader. It grows only with decisions and elections.
- **The lease ref.** `refs/notes/blueprint-lease/<task>`: who leads and until
  when. Elections, heartbeats and resignations are small commits here, so
  keeping a lease alive never touches the decision log.
- **Workers.** Builders, reviewers and the gate run work but decide nothing.
  Their callbacks go to whoever leads.

## The protocol

Every write to the log is a push of one commit whose parent is the tip the
writer read. Git rejects the push if the tip moved, so the log is a
compare-and-swap register: of two writers that read the same tip, exactly one
lands.

1. **Campaign.** A peer that needs a decision reads the lease ref. If the
   lease has expired, or there is none yet, it appends an election: term + 1,
   itself as leader, a fresh lease. If the push is rejected, someone else
   moved first: read again. Having won the lease, it appends a term marker to
   the decision log; if the log already holds a newer term (it stalled, and
   another peer took over meanwhile), it stands down.
2. **Lead.** The leader loads state from the tip's `state.json` and decides.
   A decision counts only once it is in Git: the leader appends a commit with
   the decision, the new state and a renewed lease, and answers only after the
   push lands. Decisions that arrive while a push is in flight go out together
   in the next commit (group commit), so throughput doesn't drop to one decision
   per round trip.
3. **Fencing.** Every decision is appended on the tip the leader last wrote. A
   new leader's term marker moves the tip, so a stale leader's next push is
   rejected; it reads the log, finds the newer term, and stops deciding. Two
   leaders can never both land decisions. Safety rests on this alone; the
   lease only decides who may try.
4. **Heartbeat.** The leader renews its lease on the lease ref when two thirds
   of it has passed, from its Durable Object alarm, so it keeps leading while
   its agent's model is parked. Finding another peer's lease there deposes it.
5. **Hand-off.** The leader stays in charge while any change on the task is
   active, even after its own change ends: reads come from its memory and new
   changes skip an election. When the last active change merges or is
   abandoned, it appends a resignation (lease ends now), and the next change to
   arrive wins the next term at once instead of waiting out the lease.
6. **Failover.** If a leader vanishes, its lease runs out and the next peer
   that needs a decision campaigns. Decisions pause for at most the lease.

## Requests

The Worker (HTTP and MCP) is stateless. It reads the leader from the log tip and
calls that peer's Durable Object by name. If the lease has expired, it asks the
peer of the change making the request (or, for `open_change`, the new change's
peer) to campaign first. A peer that is called but is no longer leader answers
with the current leader, and the Worker retries there once.

Reads that need no decision (`list_claims`, `change_status`, the dashboard) are
served by the leader if one is alive, or straight from the tip's `state.json`.

## Timers

The leader owns the task's timers (claim leases, parked-builder timeouts) in its
own alarm. A new leader schedules them from the state it loads.

## Safety and liveness

- **Safety:** one decision log, written only by compare-and-swap, fenced by
  term. Every decision a client was told about is in Git, so a new leader
  never forgets a grant.
- **Liveness:** as long as any change on the repo is active, some peer can
  lead. With no active changes there is nothing to coordinate; the next change
  to arrive elects itself.
- **Cost:** a decision waits for one Git push (about 1–4 s), instead of a
  local write. Group commit keeps many concurrent decisions to a few pushes.

## Milestones

1. The log protocol as a pure module over a compare-and-swap interface, with an
   in-memory fake: campaign, lead, fence, heartbeat, resign, group commit.
   Test-first: racing campaigns, lease expiry takeover, a stale leader fenced,
   decisions never lost across a takeover.
2. The Git implementation of that interface (one shallow fetch to read, one
   push to append), tested against a local Git server.
3. The Peer Durable Object running open-mode decisions as leader, with state
   from the log; the Worker routing requests to the leader.
4. Workers' callbacks (builder, reviewer, gate) routed to the leader; timers
   moved to the leader's alarm.
5. Remove the fixed Coordinator from open mode.
6. Failover test and benchmark: kill the leader mid-run, measure time to
   recovery and decision latency.
