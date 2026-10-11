# GitHub pull requests: GitHive's work reaches GitHub through a PR

Status: built, 2026-10-11, on branch `github-pr`. This adds to [design.md](design.md), "Connected to GitHub".

## Why

A connected repo pushes `main` to GitHub's `main` after every landing (fast-forward only). Teams trying GitHive
on a repo they care about are wary of a new tool writing straight to their `main`. PR mode lets GitHive's work
collect on GitHive and reach GitHub through a pull request, merged the normal GitHub way.

## Settings

`settings { github: "owner/name", github_sync: "mirror" | "pr", github_trust: true | false }`.
- **A link made before modes keeps today's behaviour exactly.** It has no `sync` recorded: it mirrors `main` after
  each landing, brings nothing of GitHub's back, and trusts nothing. Inbound, and trust, apply only to a link whose
  `github_sync` is set, to `"pr"` or `"mirror"`, through `settings` or the dashboard's Settings tab (which offers it
  for such a link). Setting `github_trust` alone sets no mode.
- `pr` is the default for new connections (`NEW_CONNECTION_SYNC` in `src/toolkit/github-settings.ts`: Andy may
  prefer `mirror`; it's one constant). A new connection records `sync` and `trust` explicitly, so it brings GitHub's
  changes back, and changing the constant later moves no repo.
- `bringsGitHubBack(registry)` (a mode is recorded) gates the notice after a landing, `github_pr`'s notice and the
  job's import step; `trustsGitHub` needs it too, so the merge path and the audit give a link without a mode no trust.
  Settings replies say `githubInbound`, and the dashboard's snapshot `inbound`.
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
    GitHive's work, newest first (at most 50, then "…and <n> more since <sha>"): each change's intent, agent, and
    reviewers with their evidence, read from the branch's merge commits and votes as the History tab reads them
    (`github-pr.ts`, `landedSince` in `history.ts`). "Since" starts at GitHub's head, or for a head GitHive brought
    in, the GitHive commit its import found GitHub had taken; githive-github's own merges are left out. When GitHub's
    head is no commit of GitHive's main and no import has it yet (someone pushed to GitHub, or GitHub merged and the
    job hasn't brought it back), GitHive can't tell which changes GitHub lacks: the title and body say "since
    GitHub's branch last took GitHive's work" and list none, rather than every change since GitHive started.
    Refreshing once the job has brought GitHub's commit back lists them;
  - everything in it an agent wrote (intents, change ids, agent and reviewer names, roles, evidence) is inert: one
    line, capped (200 characters for an intent or evidence), in a code span (`inert`). GitHub acts on a pull
    request's body, closing an issue a keyword names ("Fixes #12") when it merges and notifying "@user" or
    "@org/team", but not on anything in code, so an agent can't close issues or ping people through it.
  - `github_pr { refresh: true }` rewrites the title and body, and points the pull request at GitHub's default
    branch if that changed since it was opened (asked without refresh, it says so). A pull request closed on GitHub
    without merging is no longer open, so the next `github_pr` opens another.
  - Merging and closing it happen on GitHub.
- The repo's `GitHubSync` keeps the pull request as last seen, for the dashboard's link: a hint. It's updated when
  `github_pr` finds or opens one, and after an import lands in pr mode (one read, given 5 seconds: merged and
  closed, or still open).

## Inbound: GitHub's changes come back as a trusted change

GitHub's branch can hold commits GitHive's `main` lacks: the PR's merge, squash or rebase commits, or commits
people pushed there directly. They come back through GitHive's own path, so the record and the audit stay whole.

1. **Noticed after a landing** (for a link with its mode set). After pushing `githive/main` (or `main` in mirror
   mode), GitHive reads GitHub's default branch head: one API call, made with the last answer's ETag, so an
   unchanged branch costs nothing against GitHub's rate limit. The merging agent's request waits for it, so it's
   given 5 seconds (`NOTICE_WITHIN_MS`) and then given up, caught and logged like any failure there: the next
   landing looks again. In mirror mode a push GitHub took means its main is GitHive's, so the read is made only
   when the push was refused. The `github_pr` tool, and so the dashboard's pull request button, notice it as well;
   showing the repo page doesn't. GitHive never polls: no timers. A commit already brought back, found on main, or sent to a person isn't started again (unless
   `github_pr` asks with `refresh`). A job that waited goes on from the step it waited at; one that failed starts
   again an hour on, or when asked, so a commit that can't come in doesn't start a container at every landing.
2. **Imported.** The repo's `GitHubSync` starts a job (`github-sync.ts`, `github-inbound.ts`). Main's last 1,000
   first-parent commits are read through Artifacts' API first: a commit on them, or merged into them, needs no
   container. Otherwise:
   - the repo's GitHub Gate fetches GitHub's branch and, unless main has its head, writes it to the project repo as
     the branch `github/<branch>`, written by the toolkit (force, since it's GitHive's own copy), never by an agent
     (`gate-github.ts`). It's a Gate of its own (`repo:<repo>:github`, `githubGate`), not the repo's, which lands
     batches one at a time: a slow GitHub fetched there would hold up every landing that needs the Gate. Like the
     repo's own, it never runs a change's code, so it may write `github/<branch>`. The fetch is given 2 minutes and
     tried twice;
   - a squash or rebase merge gave GitHive's commits new ids, so git's own merge base would be GitHub's branch from
     before the PR, and merging would set the PR's own lines against what landed on GitHive since. So the Gate
     finds the newest commit of GitHive's main (searching its first-parent history back to the merge base) whose
     tree a commit on GitHub's branch has: the work GitHub took. Newest on main's side, not GitHub's: a GitHub commit
     going back to an older state of GitHive's (reverting what a squash took) is GitHub's own change, made after it
     took the newer, and comes back as a revert. If that commit isn't already an ancestor of
     GitHub's (as it is for a merge commit), the Gate joins them: a commit with GitHub's tree and both as parents,
     with GitHub's commit's dates, so making it again makes the same commit. That join is `github/<branch>`, and
     merging it brings in only what GitHub added;
   - an import record (`refs/notes/githive-github/<repo>`, appended by compare-and-swap, once per commit and head)
     notes the GitHub repo, branch and commit, the head written, and the GitHive commit whose work it had, stamped
     like every record (by `service:githive-github`). Its shape is pinned, and its reads are checked against a
     schema.
3. **Merged as a change.** GitHive's service agent `githive-github` claims a `source` merge of `github/<branch>`
   into `main` (design.md, "Branches"), as change `github-<sha12>`, so the claim holds the paths GitHub changed
   while it lands. Branches under `github/` are reserved: the import forces them, so no claim may name one as `into`
   or `from` (nor the dashboard make one), and only `githive-github` may name one as `source`. A merge that changes no file (a PR's merge commit, a squash joined to what it took) claims no
   paths: a source merge whose commits change nothing now claims nothing, and still merges. An older GitHub change
   of the same branch still open (it needed a person) is released first: the newer commit has it. A claim refused
   because others hold the paths waits, and claims again the next time GitHub's branch is noticed.
4. **Landed without review, with checks.** The change is trusted: it needs no approvals, whatever the policy. It
   lands in a batch, through the repo's checks when it has any, with trees or, when it needs a real merge (GitHub's
   commits often aren't on top of main), in the repo's Gate like any change that needs one. So a connected repo
   without checks does start the repo's Gate now and then, and the GitHub Gate for each import. Other merges'
   batches leave it to its own merge (githive-github's, or a person's from the dashboard), which test-merges it
   first: a conflict sends it back with no vote to show it, and in another merge's batch it would break every
   landing. If the checks fail or it conflicts, it is sent back like any change: githive-github asks people
   (`ask_human`, once: asked again while the question is open, it doesn't ask twice), so the dashboard shows it as
   "GitHub's changes need a person" with the reason, and its claim waits on a person. Fixing it on GitHub (merging
   `githive/main` there) brings the fix back, which lets the stuck change go; or a person gives it up (below).
6. **Given up, when it can't wait.** A GitHub change sent to a person holds its paths, and only its agent may release
   a claim, which no one can act as. So a person who can write may give it up from the dashboard ("Give up GitHub's
   changes", on the change's page; `POST /repos/:owner/:name/changes/:change/give-up`), and a repo admin through
   `release` (naming the change, as their own agent; the MCP front door tells the toolkit the caller's level). It's
   the one exception to "only the holder releases", recorded like a stale release (`stale: true`, the reason "GitHub's
   changes given up by <who>") and stamped with who did it; the audit accepts a stamped release of
   `githive-github`'s claim at any time (`giveUpGitHubChange`). Its paths are free at once. The job ends ("given up")
   and waits: GitHub's branch moving starts it again, as does a person asking (the dashboard's "Bring them in again",
   `POST /repos/:owner/:name/github/again`, or `github_pr` with `refresh`). Only GitHub's changes are given up this
   way.
7. **Recorded.** The merge commit says "Bring in GitHub's changes (owner/name main at <sha>)", with the usual
   trailers.

Once GitHub's commit is on `main`, the next PR shows only what's new, even after a squash merge, and a mirror's push
is a fast-forward again.

- **The trust rule,** one function (`trustedGitHubChange` in `github-imports.ts`) that the merge path and the audit
  both apply, so they never disagree. A merge needs no votes when all of these hold:
  - its claim is by `githive-github` with `source: github/<branch>`, and every record of it (a claim spread over
    shards has several), as written, is stamped as `service:githive-github` (with a stamp key). The merge path reads
    those records for it, since the merged view of a claim carries no stamp;
  - its head is a commit in the import record (a stamped entry, for that branch);
  - the repo's GitHub trust is on, connected to the GitHub repo the import came from: for the merge path, in the
    registry it's checked against; for the audit, in the registry state the merge cites.

  Anything else that skips a vote is refused by the merge, and reported by the audit, as today. A hosted agent acting
  as `githive-github` (they can) gets no trust: its records are stamped as itself.
- **Trust is a setting:** `github_trust` defaults to true. Turned off, GitHub's changes need review like any change:
  the job's merge waits for review, reviewers see the change in `reviews`, and once approved it lands with the next
  notice's merge.
- **Advice follows the rule.** While trusted, `status` says the change needs no review, `reviews` offers it to no
  one, and the abandoned rule treats it as approved (so its claim waits on a person only once it's asked one).
- **Who runs it.** Steps 2 to 4 must not hold up the landing that noticed GitHub moved. They run as a small,
  resumable job owned by the repo, in its `GitHubSync` Durable Object (a new class, migration `v15`), with an alarm
  per step like the hosted builder's. Every step is idempotent, so a retried step finds its work done. A step that
  throws is tried again, waiting 30 s, 1, 2 and 4 minutes, then the job counts as failed (see step 1 for when it
  starts again). A job not heard from in an hour has lost its alarm, and a notice starts it again. The landing only
  notes that GitHub is ahead and starts the job. The job's own merges push to GitHub as any landing does, but don't
  notice GitHub's branch, which would call the object back while its step runs.
- **A merge step stays within an alarm.** The runtime stops an alarm after 15 minutes, and a merge can wait 10 for
  its turn and then land batches whose checks run for minutes. So the job's merge (`JOB_MERGE`) waits for its turn
  at most 4 minutes, then answers pending; the job records that ("waits for its turn to land") and merges again at
  its next alarm, never holding on. When its turn comes, its batch is its own change alone, so a slow check, or the
  runtime stopping the alarm, costs no other change anything: the lease lapses within 2 minutes and the next merge
  goes on. A merge refused because main kept moving under its batch is tried again 30 seconds on, however often:
  that's a busy repo, not something for a person. A check run itself longer than an alarm allows is cut off with
  it, and the change's own batch is tried again at the next alarm.

## The dashboard

- By the repo's name: the GitHub repo, and in pr mode the pull request's link, or for people who can write the "Open
  a pull request on GitHub" button. When bringing GitHub's changes back needs a person, waits, was given up or
  failed, it says so there, linking to the change; once it stopped (a person, given up, failed), people who can write
  get "Bring them in again".
- GitHub's change's page offers people who can write "Give up GitHub's changes" (step 6).
- The Settings tab: the GitHub repo, how GitHive's work reaches it (`github_sync`), and whether its changes are
  trusted (`github_trust`), for admins; the same in words for everyone else.
- The Changes tab labels GitHub's change "from GitHub, trusted"; its page and sidebar say it needs no review instead
  of counting approvals.

## What doesn't change

- A link made before modes works exactly as before: it mirrors, and a push someone made to GitHub only refuses the
  next one. GitHub Actions checks and importing a repo work as before. A link set to `mirror` also brings back what
  was pushed to GitHub directly.
- GitHub is never force-pushed.

## Tests

A fake GitHub (`test/helpers/fake-github.ts`: REST answered in the test, git over HTTP by another repo on the
real-git test server) plays GitHub, as GitHive's tests fake Artifacts.
- In `pr` mode a landing pushes `githive/main`, not `main`, and reads GitHub's branch once (`github-pr.test.ts`).
- `github_pr` opens one PR and finds it after that, with refresh. Its body gives GitHub nothing to act on in what
  agents wrote: "Closes #12", "@org/team" and markup stay in code spans. It lists at most 50 changes, and none when
  GitHub's head isn't a commit GitHive has.
- Each kind of GitHub merge comes back as one trusted change that lands without votes and passes the audit: a merge
  commit, a squash and a rebase; the next PR lists only what's new (`github-inbound.test.ts`).
- A direct push on GitHub comes back the same way.
- A conflicting GitHub change is sent back to a person, not landed, and a fix on GitHub lets it go. A person who can
  write gives it up from the dashboard, or a repo admin through `release` (an agent who can only write can't), and
  its paths are free at once, the audit accepting the release; noticed again, the same commit starts nothing, and
  asked again it comes back.
- With trust off, review is needed.
- The Gate's import joins a squash or rebase to what it took, so it merges cleanly where git's own merge base
  conflicts (`github-import.test.ts`). It runs in the repo's GitHub Gate: the repo's own Gate refuses it. A revert on
  GitHub of what a squash took comes back as a revert.
- The audit reports every way a vote could be skipped short of the trust rule (`github-audit.test.ts`), and the
  merge path refuses them: a claim as `githive-github` stamped as another identity, a head the import record doesn't
  hold, a repo connected to another GitHub repo since the import, another agent's claim of `github/main`
  (`github-inbound.test.ts`).
- Branches under `github/` are reserved: a claim into or from one, or an agent's `source` merge of one, is refused.
- The import record's shape is pinned.
- What can go wrong bringing GitHub's changes back (`github-inbound.test.ts`): checks that fail on GitHub's change,
  in containers or on Actions, send it to a person and land nothing, and a fix pushed on GitHub lands; a step that
  dies after its claim, or after its merge landed, before the job noted it, finds its work done when run again (a
  merge's claim release names the commit it landed as); a step's outcome is dropped when a newer notice replaced its
  job; GitHub's branch moving on while a change waits on a person lets the older one go; a GitHub branch sharing no
  history with main fails, saying so; a force-pushed GitHub branch brings in what it added and drops nothing of
  GitHive's. The job's merge waits for its turn within its bound, lands its own change alone, and goes on however
  often main moves under it.
- `github_pr` opens another pull request after one was closed unmerged, points one at a changed default branch, and
  works in pr mode with no `GitHubSync` binding (`github-pr.test.ts`).
- A failing GitHub API, a refused push or a failing import never fails a landing, and an API that takes the read
  and never answers is given up after 5 seconds, the merging agent answered (`github-pr.test.ts`, `github.test.ts`).
- A link with no `github_sync` never starts the GitHub job (no API call, nothing brought back, `github_pr` included);
  setting `github_sync` to `mirror` turns inbound on, trusted (`github-inbound.test.ts`, `github-settings.test.ts`).
