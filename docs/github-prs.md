# GitHub pull requests: GitHive's work reaches GitHub through a PR

Status: proposed, 2026-10-11, on branch `github-pr`. This adds to [design.md](design.md), "Connected to GitHub".

## Why

A connected repo pushes `main` to GitHub's `main` after every landing (fast-forward only). Teams trying GitHive
on a repo they care about are wary of a new tool writing straight to their `main`. PR mode lets GitHive's work
collect on GitHive and reach GitHub through a pull request, merged the normal GitHub way.

## Settings

`settings { github: "owner/name", github_sync: "mirror" | "pr" }`.
- `mirror` is today's behaviour, and stays the default for repos already connected.
- `pr` is the default for new connections. Andy may prefer `mirror`; it's one constant.
- The choice is stored with the repo's GitHub link in the registry, like `github` today, and changes through
  `settings` and the dashboard's Settings tab.

## Outbound: one standing pull request

In `pr` mode:
- **After every landing,** GitHive pushes `main` to `githive/main` on GitHub, from the repo's Gate, exactly as it
  mirrors `main` today: fast-forward only, refused and logged if someone pushed to `githive/main`, off the critical
  path.
- **One pull request,** from `githive/main` into GitHub's default branch, stays open. It updates itself whenever
  `githive/main` moves, so there's no API call per landing.
- **Opening it:**
  - the `github_pr` tool (`{ repo }`; admin or write level) and a dashboard button ("Open a pull request on
    GitHub") open it, or say where it is if it's already open;
  - its title is "GitHive: <n> changes", and its body lists what landed on GitHive since GitHub's branch last
    took GitHive's work: each change's intent, agent, and reviewers with their evidence (from the merge commits'
    story).
  - `github_pr { refresh: true }` rewrites the title and body.
  - Merging and closing it happen on GitHub.

## Inbound: GitHub's changes come back as a trusted change

GitHub's branch can hold commits GitHive's `main` lacks: the PR's merge, squash or rebase commits, or commits
people pushed there directly. They come back through GitHive's own path, so the record and the audit stay whole.

1. **Noticed after a landing.** After pushing `githive/main` (or `main` in mirror mode), GitHive reads GitHub's
   default branch head: one API call. In mirror mode, a refused push already says GitHub moved. The `github_pr`
   tool and the dashboard can start step 2 as well. GitHive never polls: no timers.
2. **Imported.** If GitHub's head isn't on GitHive's `main`:
   - the repo's Gate fetches it and writes it to the project repo as the branch `github/<branch>`, written by the
     toolkit, never by an agent;
   - an import record (`refs/notes/githive-github/<repo>`, appended by compare-and-swap) notes the GitHub repo,
     branch and commit, stamped like every record.
3. **Merged as a change.** GitHive's service agent `githive-github` claims a `source` merge of `github/<branch>`
   into `main` (design.md, "Branches"), so the claim holds the paths GitHub changed while it lands.
4. **Landed without review, with checks.** The change is trusted: it needs no approvals, whatever the policy. It
   lands in a batch like any change, through the repo's checks when it has any. If the checks fail or it
   conflicts, it is sent back like any change, and the dashboard shows it as "GitHub's changes need a person"
   with the reason.
5. **Recorded.** The merge commit says "Bring in GitHub's changes (owner/name main at <sha>)", with the usual
   trailers.

Once GitHub's commit is on `main`, the next PR shows only what's new, even after a squash merge.

- **The audit** accepts a merge with no votes when all of these hold:
  - its claim is by `githive-github` with `source: github/<branch>`;
  - its head is a commit in the import record;
  - the repo's GitHub trust was on when it merged.

  Anything else that skips a vote is reported as today.
- **Trust is a setting:** `github_trust` defaults to true. Turned off, GitHub's changes need review like any change.
- **Who runs it.** Steps 2 to 4 must not hold up the landing that noticed GitHub moved. They run as a small,
  resumable job owned by the repo, with an alarm per step like the hosted builder's. Every step is idempotent, so a
  retried step finds its work done. The landing only notes that GitHub is ahead and starts the job.

## What doesn't change

- `mirror` mode, GitHub Actions checks and importing a repo work as today.
- GitHub is never force-pushed.

## Tests

Use a fake GitHub (REST and git over HTTP), as GitHive's tests fake Artifacts, with the real-git test server for
git.
- In `pr` mode a landing pushes `githive/main`, not `main`.
- `github_pr` opens one PR and finds it after that, with refresh.
- Each kind of GitHub merge comes back as one trusted change that lands without votes and passes the audit: a
  merge commit, a squash and a rebase.
- A direct push on GitHub comes back the same way.
- A conflicting GitHub change is sent back, not landed.
- With trust off, review is needed.
- The import record's shape is pinned.
- A failing GitHub API never fails a landing.
