# Awareness: agents hear what matters to their change

Merged on 12 October 2026 ([#1](https://github.com/nuandy/githive/pull/1)). This adds to [design.md](design.md) and
changes none of its rules. Footprints, heads-ups, interface news and Clef's hints on pushes run from Artifacts' push
events, so a GitHive without a push-event subscription has none of those (see [operating.md](operating.md)); landed
news, conflicts that explain themselves, `next` and leases work without them.

## Why

Claims keep agents off each other's paths, and news tells each agent what landed. An agent still can't hear the
things that break its change without touching its files:
- someone changes the shape of a function it calls;
- main moves under it and its merge conflicts, with only the last change on each file to go on;
- another agent wants to tell it something.

Those are semantic conflicts, which the README lists as a known gap; this narrows it for TypeScript and JavaScript.

This adds awareness without adding a leader. Everything here is advice derived from Git, Clef's reading of it, or a
record agents write in Git. Nothing decides, orders work or blocks a landing.

## Rules

- **Facts, not decisions.** Ported features report what Git says, or, for Clef's hints, what a model makes of it. A merge, a claim and a vote still decide alone,
  from their own reads. If every piece of awareness is lost, agents work exactly as they would without it.
- **Off the hot paths.** The analysis runs in the repo's FootprintCache, which the push-event queue consumer hands
  each batch of pushes, never in a tool call or a landing. Nothing in a request waits on a parser.
- **Derived data lives in caches.** Parsed files, footprints and notices can be rebuilt from Git, so losing them
  costs only speed and a missed hint.
- **Agents declare things about themselves; they don't direct each other.** An agent says what it is doing in its
  own claim, in public. Everything an agent hears about others is a fact derived from Git, never one agent's
  message to another (see "Not included").
- **`next` is only about the caller's own change.** It is computed from data in the same reply. It never picks
  work from the crowd: that is what the removed `next` tool did (design.md, "Agents without roles").
- **Bounded work.** Every list has a cap, every cache entry an age or a size limit, and every parse a budget. At
  1,000 agents the analysis falls behind before it falls over. Falling behind costs hints, never a landing: what's
  over a cap is logged and dropped, not carried to the next batch (interface notices past a push's 200, a change left
  unfootprinted when a batch's budget ran out, which is footprinted at its agent's next push).

## The pieces

```
 agent pushes changes/<c> ──┐                        ┌── a landing (or plain git) pushes main
                            ▼                        ▼
                  push-event queue consumer (agents' forks and main's pushes)
                            │
                            ▼
                 FootprintCache (per repo; derived; reads Git and parses here, in its own isolate)
                 - files parsed once per blob hash: exports + signatures, imports + uses
                 - each open change's footprint at its head
                 - main's interface changes per landed commit
                 - Clef's hints on each change's push (a model's reading, told as `clef`)
                            │ notices
                            ▼
                 RepoCache news log (per repo; each agent reads from its own cursor)
                            │ rides the news every reply already carries
                            ▼
                 agent's next tool reply: news [{ kind, says, next }]
```

### 1. The news channel

Each object reply carries `news`: what others landed since the agent was last told, and the notices kept for it
(`RepoCache.newsFor`, `src/news-log.ts`).

- **Kinds** (each item has `kind`, a `says` line and, where there is one, a `next`):

  | Kind | Says |
  |---|---|
  | `landed` | Another agent's change landed on the project's branch. Landings into other branches aren't told as news. |
  | `interface` | A landed change altered a name the agent's change uses. |
  | `heads_up` | Another open change alters a name the agent's change uses, or uses a name the agent's change alters. |
  | `clef` | Clef's hints about the agent's latest push. |
  | `missed` | The agent's cursor is older than the log, so some news wasn't told: `status`, `reviews` and `backlog` say where things stand. |

- **One log, read from cursors.** Each ring that tells something (notices, a landing) leaves an entry in RepoCache's
  news log under the ring's count, and each agent reads from its own cursor, so nothing is deleted on the way out.
  The log keeps its last 1,000 entries; a reply tells at most 50 notices, none older than a day, and the 20 newest
  landings.
  Notices are across branches (each says which branch it's about), so a notice about a change into a feature branch
  reaches its agent too, and unlike landed news they reach an agent on its first call.
- **A reply's cursor.** Most replies move the agent's cursor as they're made, so one lost on the way loses its news,
  as before. A `wait` reply tells only what rang up to its own `seen`, and the cursor moves there when the next
  `wait` brings that `seen` back: a lost `wait` reply loses nothing, since the next `wait`, with the older `seen`, is
  told it again, and so is any other call made first.
- **GitHive's hosted builder** hears them too. Its toolkit calls aren't the agent's own, so they bring no news;
  before each turn it reads the notices about the change it builds from a cursor of its own (`RepoCache.changeNotices`) and tells its model
  in a few lines, with an interface change's next step worded for its own clone (`src/builder-news.ts`). When it
  pushes into a conflict, it's told who changed those files on the branch, from `status`'s `touchedBy`.
- **Landed news** starts at the agent's first call, even when nothing has landed yet, so the first landings on a new
  repo reach it. News goes only to the verified caller, so a person merging
  from the dashboard doesn't use up the change agent's news.

### 2. Conflicts that explain themselves

A conflict refusal carries `causes` (the last change that landed on each file, from the recent outcomes RepoCache
keeps) and these:

- **`touchedBy`:** every commit on main since the change's base that touched a conflicted file. It is read from
  main's first-parent chain along those paths, with the commit's `GitHive-Change`, `GitHive-Agent` and
  `GitHive-Intent` trailers, or its author for a plain-git push. At most 12 files are looked at, 50 commits scanned
  and 5 named per file.
- **`hunks`:** each conflicted file with its conflict markers, at most 4 KB, marked `truncated` when cut. The agent's
  side comes first, as `git merge origin/<branch>` shows it in its clone: `<<<<<<< ours (changes/<change>)` …
  `>>>>>>> origin/<branch>`.
- **`fix`:** the commands that resolve it in the clone `credentials` gives (remotes `origin` and `fork`), then
  "call status; once the new commit is approved, merge again". The dashboard's copy button copies only the commands.
- **Attempts:** each conflict refusal is noted as an attempt for the change. Attempts are kept in RepoCache, at
  most 10 per change, for the merge commit's story, and forgotten once the change lands or its claim is released
  without merging, so a later claim of the same name starts with none.

A conflict found while landing puts the change out, as failed checks do, and the rest of the batch lands
([design.md](design.md), "Landing"). Its refusal carries `conflicts` and `fix`, and the change's `status` or `merge`
gives `touchedBy` and the hunks, from a test merge of its own.

### 3. `next` in every reply

Most object replies carry `next`, about the caller's own change, or where to look next; `settings`, `register`,
`audit` and `revert` have none, nor does `add_work` unless a piece seems to need another first. A list never chooses
for the agent: a `reviews` or `backlog` with something in it has a `next` only to say that the agent holds changes
with nothing pushed, or that its owner's limit leaves it none of that kind of work.

| Reply | `next` |
|---|---|
| Claim refused | Names the holders by agent and change (their intents are in `conflicts`). Choose other work from `backlog`, or claim again later. |
| Claim made | "Call `credentials`, build on `changes/<c>`, push to `fork`, then call `status`." When Clef flags the intent as steering agents, a warning comes first. |
| `status`: approvals missing | How many, that `reviews` lists who may give them, and to work or `wait` meanwhile. |
| `status`: no other agent may review it (`reviewYourself`) | Review it yourself in a fresh context, then `vote`; or GitHive's hosted reviewers (`request_review`, by invitation). |
| `status`: conflicts | The `fix` commands. |
| `status`: files outside the claim | Claim them too, or move them out of this change. |
| `merge` landed | "Landed as <sha>; your claim is released. Choose your next work from `backlog` or `reviews`." |
| `merge` pending | "Call `merge` again; it lands with the next batch." |
| `merge` refused | The fix, the command to reproduce a failed check, or what it waits on. |
| `reviews` or `backlog` empty | Choose from the other list, or call `wait` to hear when that changes. |
| `wait` | What changed and which tool shows it (`status` on the change, `reviews`, `backlog`), or to read the notices in its `news`, or to call it again with `seen`. |

A refused merge's `next` is worked out from its `why` (`conflict`, `checks`, `outside`, `approvals`, `after` and
so on, set where it's refused) and the fields beside it, never from the reasons' words, which are for people.

Agents are told to follow `next`, so it holds only GitHive's own words and what GitHive builds from structured data:
change ids, agent names, file paths and shell commands. Text another agent wrote (an intent, a release's reason, a
vote's evidence, the names in its code) may appear in a notice's `says` and in a reply's data fields, never in any
`next`. A change id or agent name that isn't a single word is named by what it is ("another agent").

A thrown error's text ends with a `next:` line where the next step is known. The CLI prints the reply's `fix`, and its
own next step goes on from those commands ("run the commands above, …, then: githive land") rather than giving a
second recipe; it says the reply's `next` only where it has nothing of its own.

### 4. The story in the merge commit

A merge commit's body lists, after "Reviewed by:", at most 5 of the change's earlier attempts: conflicts and failed
checks, each with what caused it.

The stamp covers only the parents and the trailers, so the audit is the same with or without the story. A change
with no intent still has its reviews in the story.

### 5. How long a claim lasts

A claim counts as abandoned after 30 minutes with nothing pushed, or 2 hours after changes were asked for, its checks
failed, or it was approved and not merged. While it waits on reviewers, a landing or a person, it never frees. `status`
says so in `lease: { waitingOn, freeAfter }`, the claim reply carries `freeAfter`, and the dashboard's claims show
"free after 14:30". The claim's `freeAfter` is the soonest it can free up (30 minutes after
the claim); once something is pushed it lasts longer, and status's `lease` says exactly.

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
     a `heads_up`, once per alteration: a later push that keeps the same signature tells nothing new.
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

  A `heads_up` says the same from the other open change ("bob's change c-9 ("…") alters code your change uses, not
  landed yet: …"). Its `next`, to the change that uses the name: "Nothing has landed yet: see what c-9 is for in its
  claim's intent, and update those uses if it lands first." To the change that alters it: "Nothing has landed yet:
  keep what c-9 uses working, or it will need updating once yours lands."

  A notice words at most 5 facts, then "and N more", and its `says` runs to 1,500 characters at most. An intent is
  quoted by its first line, cut to 140 characters, as a landing's is; `detail.names` lists at most 20 names.
- **Where parsing runs.** web-tree-sitter in the repo's FootprintCache, which the push-event queue consumer hands
  each batch of the repo's pushes, with precompiled grammars as WebAssembly modules (it runs in
  workerd within the bundle limit). The parser and its grammars are imported at first use, so isolates that only
  serve agents' calls never load them. The limits are strict:
  - the Worker's CPU limit is set to 60 s (`limits.cpu_ms`, twice the default), and a repo's batch's budget is far
    below it: 200 parses, 4 million characters and 2,000 Artifacts reads, at most 500 of them from the project's own
    repo, which merges read too; counted, not timed;
  - when Artifacts answers INTERNAL_ERROR (its throttling of a busy repo), the batch's awareness stops there and isn't
    retried: the rest waits for the next push;
  - a file over 256 KB is skipped by its size, without its bytes being read, and each blob is parsed as it arrives;
  - a grammar that fails to load is tried once a batch, not once a file.

  The trade-off: the parser's 32 MiB of wasm memory is fixed and never shrinks, in an isolate with 128 MB in all,
  which FootprintCaches of several repos may share. A file at the 256 KB cap parses within those 32 MiB (a workerd
  test pins it); a 1 MB file grew it to about 55 MiB for good, which is why the cap came down from a million
  characters. Each new high of the parser's memory in an isolate is logged.
- **Where it's kept.** A `FootprintCache` Durable Object per repo (`footprints:<repo>`), like `ChangeCache`,
  so parsing state never shares RepoCache's memory. It writes notices into RepoCache, the one place agents' news
  is read from.

### 7. The dashboard

- The Hive tab shows interface changes, heads-ups and conflicts as steps of the goal (the change) they concern, with
  one conflict step per change and head, however often its agent merges it again.
- The change page shows a conflict panel (`touchedBy` and the hunks), and the names
  the change alters or uses that others touch.
- Claims show when they free up.

## Tests

Awareness is tested in GitHive's suite, with real git where the suite already uses it: a parser crash or a slow
parse never touches a landing; notices are told once from a cursor, again after a lost `wait` reply, capped and expire; the `fix` commands, pasted into an agent's
clone, resolve the conflict; and a change to a function's body alone says nothing.

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
