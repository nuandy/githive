# GitHub pull requests: GitHive's work reaches GitHub through a PR

Status: built, 2026-10-11, on branch `github-pr`. This adds to [design.md](design.md), "Connected to GitHub".

## Why

A connected repo pushes `main` to GitHub's `main` after every landing (fast-forward only). Teams trying GitHive
on a repo they care about are wary of a new tool writing straight to their `main`. PR mode lets GitHive's work
collect on GitHive and reach GitHub through a pull request, merged the normal GitHub way.

## Settings

`settings { github: "owner/name", github_sync: "mirror" | "pr", github_trust: true | false }`.
- `mirror` is today's behaviour, and stays the mode of repos already connected: a link recorded before modes
  existed has no `sync` and reads as `mirror`.
- `pr` is the default for new connections (`NEW_CONNECTION_SYNC` in `src/toolkit/github-settings.ts`: Andy may
  prefer `mirror`; it's one constant). A new connection records `sync` and `trust` explicitly, so changing the
  constant later moves no repo.
- The choice is stored with the repo's GitHub link in the claims registry (`github: { repo, sync, trust }`), and
  changes through `settings` and the dashboard's Settings tab. Naming the same repo again keeps its mode; another
  repo is a new connection. `github_sync` or `github_trust` without a connected repo is refused.
- The link's shape is pinned in `test/fixtures/record-shapes.json`. Its new fields are optional, so older records
  read as before and no format bump was needed.

## Outbound: one standing pull request

In `pr` mode:
- **After every landing,** GitHive pushes `main` to `githive/main` on GitHub, from the repo's Gate, exactly as it
  mirrors `main`: fast-forward only, refused and logged if someone pushed to `githive/main`, off the critical
  path (it runs after the lease is handed on, and its failures are caught and logged; `github-outbound.ts`).
- **One pull request,** from `githive/main` into GitHub's default branch, stays open. It updates itself whenever
  `githive/main` moves, so there's no API call per landing for it.
- **Opening it:**
  - the `github_pr` tool (`{ repo }`; write level, which admins have) and a dashboard button ("Open a pull request
    on GitHub", `POST /repos/:owner/:name/github/pr`) open it, or say where it is if it's already open. Opening
    pushes `githive/main` first, for a repo connected since its last landing;
  - its title is "GitHive: <n> changes", and its body lists what landed on GitHive since GitHub's branch last took
    GitHive's work, newest first (at most 100, then a count): each change's intent, agent, and reviewers with their
    evidence, read from the branch's merge commits and votes as the History tab reads them (`github-pr.ts`).
    "Since" starts at GitHub's head, or for a head GitHive brought in, the GitHive commit its import found GitHub had
    taken; githive-github's own merges are left out.
  - `github_pr { refresh: true }` rewrites the title and body.
  - Merging and closing it happen on GitHub.
- The repo's `GitHubSync` keeps the pull request as last seen, for the dashboard's link: a hint. It's updated when
  `github_pr` finds or opens one, and after an import lands (one read: merged and closed, or still open).

## Inbound: GitHub's changes come back as a trusted change

GitHub's branch can hold commits GitHive's `main` lacks: the PR's merge, squash or rebase commits, or commits
people pushed there directly. They come back through GitHive's own path, so the record and the audit stay whole.

1. **Noticed after a landing.** After pushing `githive/main` (or `main` in mirror mode), GitHive reads GitHub's
   default branch head: one API call, made with the last answer's ETag, so an unchanged branch costs nothing
   against GitHub's rate limit. In mirror mode a push GitHub took means its main is GitHive's, so the read is made
   only when the push was refused. The `github_pr` tool and the dashboard notice it as well. GitHive never polls:
   no timers. A commit already brought back, found on main, or sent to a person isn't started again (unless
   `github_pr` asks with `refresh`); a job that waited or failed is.
2. **Imported.** The repo's `GitHubSync` starts a job (`github-sync.ts`, `github-inbound.ts`). Main's last 1,000
   first-parent commits are read through Artifacts' API first: a commit on them, or merged into them, needs no
   container. Otherwise:
   - the repo's Gate fetches GitHub's branch and, unless main has its head, writes it to the project repo as the
     branch `github/<branch>`, written by the toolkit (force, since it's GitHive's own copy), never by an agent
     (`gate-github.ts`);
   - a squash or rebase merge gave GitHive's commits new ids, so git's own merge base would be GitHub's branch from
     before the PR, and merging would set the PR's own lines against what landed on GitHive since. So the Gate
     finds the newest commit of GitHive's main (searching its first-parent history back to the merge base) whose
     tree a commit on GitHub's branch has: the work GitHub took. If that commit isn't already an ancestor of
     GitHub's (as it is for a merge commit), the Gate joins them: a commit with GitHub's tree and both as parents,
     with GitHub's commit's dates, so making it again makes the same commit. That join is `github/<branch>`, and
     merging it brings in only what GitHub added;
   - an import record (`refs/notes/githive-github/<repo>`, appended by compare-and-swap, once per commit and head)
     notes the GitHub repo, branch and commit, the head written, and the GitHive commit whose work it had, stamped
     like every record (by `service:githive-github`). Its shape is pinned, and its reads are checked against a
     schema.
3. **Merged as a change.** GitHive's service agent `githive-github` claims a `source` merge of `github/<branch>`
   into `main` (design.md, "Branches"), as change `github-<sha12>`, so the claim holds the paths GitHub changed
   while it lands. A merge that changes no file (a PR's merge commit, a squash joined to what it took) claims no
   paths: a source merge whose commits change nothing now claims nothing, and still merges. An older GitHub change
   of the same branch still open (it needed a person) is released first: the newer commit has it. A claim refused
   because others hold the paths waits, and is tried again the next time GitHub's branch is noticed.
4. **Landed without review, with checks.** The change is trusted: it needs no approvals, whatever the policy. It
   lands in a batch, through the repo's checks when it has any. Other merges' batches leave it to its own merge
   (githive-github's, or a person's from the dashboard), which test-merges it first: a conflict sends it back with
   no vote to show it, and in another merge's batch it would break every landing. If the checks fail or it
   conflicts, it is sent back like any change: githive-github asks people (`ask_human`), so the dashboard shows it
   as "GitHub's changes need a person" with the reason, and its claim waits on a person. Fixing it on GitHub
   (merging `githive/main` there) brings the fix back, which lets the stuck change go.
5. **Recorded.** The merge commit says "Bring in GitHub's changes (owner/name main at <sha>)", with the usual
   trailers.

Once GitHub's commit is on `main`, the next PR shows only what's new, even after a squash merge, and a mirror's push
is a fast-forward again.

- **The audit** accepts a merge with no votes when all of these hold:
  - its claim is by `githive-github` with `source: github/<branch>`, stamped as `service:githive-github` (with a
    stamp key);
  - its head is a commit in the import record (a stamped entry, for that branch);
  - the repo's GitHub trust was on when it merged, in the registry state it cites, connected to the GitHub repo the
    import came from.

  Anything else that skips a vote is reported as today.
- **Trust is a setting:** `github_trust` defaults to true. Turned off, GitHub's changes need review like any change:
  the job's merge waits for review, reviewers see the change in `reviews`, and once approved it lands with the next
  notice's merge.
- **Advice follows the rule.** While trusted, `status` says the change needs no review, `reviews` offers it to no
  one, and the abandoned rule treats it as approved (so its claim waits on a person only once it's asked one).
- **Who runs it.** Steps 2 to 4 must not hold up the landing that noticed GitHub moved. They run as a small,
  resumable job owned by the repo, in its `GitHubSync` Durable Object (a new class, migration `v15`), with an alarm
  per step like the hosted builder's. Every step is idempotent, so a retried step finds its work done. A step that
  throws is tried again, waiting 30 s, 1, 2 and 4 minutes, then the job counts as failed until GitHub's branch is
  noticed again. The landing only notes that GitHub is ahead and starts the job. The job's own merges push to GitHub
  as any landing does, but don't notice GitHub's branch, which would call the object back while its step runs.

## The dashboard

- By the repo's name: the GitHub repo, and in pr mode the pull request's link, or for people who can write the "Open
  a pull request on GitHub" button. When bringing GitHub's changes back needs a person, waits or failed, it says so
  there, linking to the change.
- The Settings tab: the GitHub repo, how GitHive's work reaches it (`github_sync`), and whether its changes are
  trusted (`github_trust`), for admins; the same in words for everyone else.
- The Changes tab labels GitHub's change "from GitHub, trusted"; its page and sidebar say it needs no review instead
  of counting approvals.

## What doesn't change

- `mirror` mode, GitHub Actions checks and importing a repo work as before. A mirror now also brings back what was
  pushed to GitHub directly, which before only refused the next push.
- GitHub is never force-pushed.

## Tests

A fake GitHub (`test/helpers/fake-github.ts`: REST answered in the test, git over HTTP by another repo on the
real-git test server) plays GitHub, as GitHive's tests fake Artifacts.
- In `pr` mode a landing pushes `githive/main`, not `main`, and reads GitHub's branch once (`github-pr.test.ts`).
- `github_pr` opens one PR and finds it after that, with refresh.
- Each kind of GitHub merge comes back as one trusted change that lands without votes and passes the audit: a merge
  commit, a squash and a rebase; the next PR lists only what's new (`github-inbound.test.ts`).
- A direct push on GitHub comes back the same way.
- A conflicting GitHub change is sent back to a person, not landed, and a fix on GitHub lets it go.
- With trust off, review is needed.
- The Gate's import joins a squash or rebase to what it took, so it merges cleanly where git's own merge base
  conflicts (`github-import.test.ts`).
- The audit reports every way a vote could be skipped short of the trust rule (`github-audit.test.ts`).
- The import record's shape is pinned.
- A failing GitHub API, a refused push or a failing import never fails a landing.
