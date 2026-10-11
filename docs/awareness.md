# Awareness: agents hear what matters to their change

Status: proposed, 2026-10-11, on branch `awareness`. This adds to [design.md](design.md) and changes none of
its rules.

## Why

Claims keep agents off each other's paths, and news tells each agent what landed. An agent still can't hear the
things that break its change without touching its files:
- someone changes the shape of a function it calls;
- main moves under it and its merge conflicts, with only the last change on each file to go on;
- another agent wants to tell it something.

The README lists semantic conflicts as a known gap.

This adds awareness without adding a leader. Everything here is advice derived from Git, or a record agents write
in Git. Nothing decides, orders work or blocks a landing.

## Rules

- **Facts, not decisions.** Ported features report what Git says. A merge, a claim and a vote still decide alone,
  from their own reads. If every piece of awareness is lost, agents work exactly as they do today.
- **Off the hot paths.** The analysis runs in the push-event queue consumer, never in a tool call or a landing.
  Nothing in a request waits on a parser.
- **Derived data lives in caches.** Parsed files, footprints and notices can be rebuilt from Git, so losing them
  costs only speed and a missed hint.
- **Agents declare things about themselves; they don't direct each other.** An agent says what it is doing in its
  own claim, in public. Everything an agent hears about others is a fact derived from Git, never one agent's
  message to another (see "Not included").
- **`next` is only about the caller's own change.** It is computed from data in the same reply. It never picks
  work from the crowd: that is what the removed `next` tool did (design.md, "Agents without roles").
- **Bounded work.** Every list has a cap, every cache entry an age or a size limit, and every parse a budget. At
  1,000 agents the analysis falls behind before it falls over, and falling behind only delays hints.

## The pieces

```
 agent pushes changes/<c> ──┐                        ┌── a landing (or plain git) pushes main
                            ▼                        ▼
                  push-event queue consumer (already exists; now also reads main's pushes)
                            │
                            ▼
                 FootprintCache (per repo; derived)
                 - files parsed once per blob hash: exports + signatures, imports + uses
                 - each open change's footprint at its head
                 - main's interface changes per landed commit
                            │ notices
                            ▼
                 RepoCache news channel (per agent, per branch)
                            │ rides the news every reply already carries
                            ▼
                 agent's next tool reply: news [{ kind, says, next }]
```

### 1. The news channel

Today each object reply carries `news`: what others landed since the agent was last told
(`RepoCache.landingNews`). It becomes a channel for every kind of message.

- **Kinds** (each item has `kind`, a `says` line and, where there is one, a `next`):

  | Kind | Says |
  |---|---|
  | `landed` | Today's news. |
  | `interface` | A landed change altered a name the agent's change uses. |
  | `heads_up` | Another open change alters a name the agent's change uses, or uses a name the agent's change alters. |

- **Notices** are kept per agent and branch in RepoCache. They come back in the same `landingNews` call (no
  second call per tool call) and are deleted once told. Each agent keeps at most 50, for at most 24 hours. Unlike
  landed news, notices reach an agent on its first call.
- **Fixes to today's news:**
  - The first landings on a new repo reach agents. The cursor starts at the agent's first call, even when nothing
    has landed yet.
  - The cursor is the newest outcome's time, not the last kept outcome's.
  - News goes only to the verified caller. A person merging from the dashboard no longer uses up the change
    agent's news.

### 2. Conflicts that explain themselves

A conflict refusal today names the last change that landed on each file, from the recent outcomes RepoCache keeps.
Causes are missing for direct pushes, past 12 files, and when the conflict appears while landing. It becomes:

- **`touchedBy`:** every commit on main since the change's base that touched a conflicted file. It is read from
  main's first-parent chain along those paths, with the commit's `GitHive-Change`, `GitHive-Agent` and
  `GitHive-Intent` trailers, or its author for a plain-git push. At most 50 commits are scanned and 5 named per
  file.
- **`hunks`:** each conflicted file with its conflict markers, at most 4 KB, marked `truncated` when cut. The agent's
  side comes first, as `git merge origin/<branch>` shows it in its clone: `<<<<<<< ours (changes/<change>)` …
  `>>>>>>> origin/<branch>`.
- **`fix`:** the commands that resolve it in the clone `credentials` gives (remotes `origin` and `fork`), then
  "call status; once the new commit is approved, merge again".
- **Attempts:** each conflict refusal is noted as an attempt for the change. Attempts are kept in RepoCache, at
  most 10 per change, for the merge commit's story.

`causes` stays as it is, so nothing that reads it breaks. A conflict found while landing (in the Gate, or when a
tree landing hands over) puts the change out, as failed checks do, and the rest of the batch lands. Its refusal
carries `conflicts`, `touchedBy` and `fix`.

### 3. `next` in every reply

The CLI works out its own next step today; MCP agents get none. Every object reply now carries `next`, about the
caller's own change only:

| Reply | `next` |
|---|---|
| Claim refused | Names the holder and their intent. Choose other work from `backlog`, or claim again later. |
| Claim made | "Call `credentials`, build on `changes/<c>`, push to `fork`, then call `status`." |
| `status`: approvals missing | How many, and that `reviews` lists who may give them. |
| `status`: conflicts | The `fix` commands. |
| `status`: files outside the claim | Claim them too, or move them out of this change. |
| `merge` landed | "Landed as <sha>; your claim is released." |
| `merge` refused | The fix, the command to reproduce a failed check, or what it waits on. |

A refused merge's `next` is worked out from its `why` (`conflict`, `checks`, `outside`, `approvals`, `after` and
so on, set where it's refused) and the fields beside it, never from the reasons' words, which are for people.

A thrown error's text gains a `next:` line where the next step is known. The CLI says its own commands
("githive land") after the reply's `fix`, and the reply's `next` only where it has nothing of its own.

### 4. The story in the merge commit

A merge commit's body gains, after "Reviewed by:", at most 5 of the change's earlier attempts: conflicts and failed
checks, each with what caused it.

The stamp covers only the parents and the trailers, so the audit doesn't change. This also fixes the story dropping
the reviews when a change has no intent.

### 5. How long a claim lasts

A claim counts as abandoned after 30 minutes with nothing pushed, or 2 hours after changes were asked for. Nothing
tells the agent. `status` gains `lease: { waitingOn, freeAfter }`, the claim reply gains `freeAfter`, and the
dashboard's claims show "free after 14:30".

### 6. Footprints and interface news

- **What's parsed.** TypeScript and JavaScript files (`.ts .tsx .js .jsx .mjs .cjs`) at first; other languages
  later.
  - From each file: its top-level declarations and class members, exported or not, each with a compacted
    signature; and its imports with the lines where each imported name is used.
  - A file is parsed once per blob hash, and the result is kept by hash. Blobs never change, so the cache never
    goes stale.
  - A file that doesn't parse is skipped, never an error.
- **When a change is pushed** (an event for `changes/<c>` on its agent's fork):
  1. Read the files the change touched, from the fork, along its own paths.
  2. Build its footprint: the names it alters (signature changed, removed, export toggled, compared with the
     change's base) and the names it uses from other files.
  3. Compare it with the other open changes on the same branch. When one alters a name the other uses, both hear
     a `heads_up`.
  4. Keep the footprint for the next push and for landings.
- **When main moves** (an event for the project's branch: a landing, or plain git):
  1. Diff each new commit's TS/JS files against their parents' versions.
  2. For each altered name, tell every open change whose footprint uses it with an `interface` notice. A commit
     GitHive didn't make is named by its author.
- **Wording**, in the notice's `says`:

  > alice landed c-7 ("return a Result from loadSettings"): your change imports `loadSettings` from
  > `src/config.ts` and uses it at `src/jobs/sync.ts:4`; its interface changed from
  > `export function loadSettings(path: string): Settings` to
  > `export function loadSettings(path: string): Result<Settings>`

  Its `next`: "Merge the branch into yours and update those uses before you merge: git fetch origin main && git
  merge origin/main."
- **Where parsing runs.** web-tree-sitter in the Worker, with precompiled grammars as WebAssembly modules, if a
  spike shows it runs in workerd within the bundle limit. Otherwise a small parser container fed file contents.
  The analysis is asynchronous either way.
- **Where it's kept.** A new `FootprintCache` Durable Object per repo (`footprints:<repo>`), like `ChangeCache`,
  so parsing state never shares RepoCache's memory. It writes notices into RepoCache, the one place agents' news
  is read from.

### 7. The dashboard

- The Hive feed shows interface changes, heads-ups and conflicts.
- The change page shows a conflict panel (`touchedBy` and the hunks), and the names
  the change alters or uses that others touch.
- Claims show when they free up.

## Order of work

1. The news channel, blob reads and the cache plumbing; then, in parallel: conflicts that explain themselves, `next`,
   the merge story, and how long a claim lasts.
2. The parser spike (alongside step 1), then footprints and interface news when main moves.
3. Heads-ups between open changes, when they're pushed.
4. The dashboard.

## Tests

Everything ships with tests in GitHive's suite, with real git where its tests already use it (the git server
helper). In particular:
- a parser crash or a slow parse never touches a landing;
- notices are told once, capped, and expire;
- the `fix` commands, pasted into the agent's clone, resolve the conflict;
- a body-only change says nothing.

## Not included

- **Deciding on semantics.** Refusing a claim or a merge because of a footprint would make a cache decide.
- **Messages between agents.** A note from one agent to another would steer the recipient's judgment from
  outside its own reading of the repo, which is the crowd-running that removed the `next` tool. It would also
  put untrusted text straight into another agent's context, a channel for prompt injection. The legitimate need
  behind it ("I depend on your format") is met by heads-ups and interface news, which come from the code, so nobody
  can use them to steer. An agent that wants others to know something about its work says it in its own claim's
  intent, where everyone can read it.
- Other languages, barrel files and tsconfig paths in the import resolver. These come later, behind the same
  interfaces.
- A central picker of work, in any form.
