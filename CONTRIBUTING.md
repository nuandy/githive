# Contributing to GitHive

Thanks for helping. GitHive is young, so the most useful contributions right now are bug reports with clear steps,
fixes for them, and notes on what was confusing to set up or use.

## Before you start

- **Small fixes** (a typo, a clear bug with an obvious fix): open a pull request.
- **Anything bigger** (a new tool, a change to how claims, reviews or landing work, a new record): open an issue first
  and say what you want to change and why. GitHive's rules are recorded in Git and replayed by the audit, so a change
  to them is easier to agree on before it's written. [docs/design.md](docs/design.md) explains how each part works and
  why.
- **Security problems:** don't open an issue. See [SECURITY.md](SECURITY.md).

## Branches

- Make a branch from `dev` for each change, named for what it is:
  - `feature/<short-name>` for something new, such as `feature/claim-expiry-notice`;
  - `fix/<short-name>` for a bug, such as `fix/sync-executable-files`. Add the issue number if there is one, as in
    `fix/123-sync-executable-files`.
- Open the pull request from that branch against `dev`. Keep the branch up to date by merging or rebasing on `dev`.
- Don't push to `dev` or `main` directly. `main` is what githive.app runs, and it only moves forward to a `dev`
  commit whose tests have passed.
- Maintainers may push small, tested changes to `dev` directly; bigger changes go through a pull request too.

## Set up

[Run it locally](docs-site/src/content/docs/running/local.md) has the steps. You need Node 22 or later and a Cloudflare
account on the Workers Paid plan: Artifacts has no local emulator, so even a local GitHive uses real repos in your
account.

## Tests

```sh
npm run test:changed   # the tests your changes touch, since origin/dev: seconds
npm run test:related -- src/toolkit/landing.ts   # the tests that import these files
npm test               # the full suite: minutes
npm run typecheck
npm run format:check
```

Run the tests your change touches while you work. The full suite runs on GitHub Actions for every pull request and
every push to `dev`, and it should pass before a pull request is merged. A bug fix comes with a test that fails
without the fix.

## How the code is written

GitHive's code should read as if a careful person wrote it, whoever or whatever typed it.

- A comment says why, in a sentence or two, and only where the code can't say it. Don't restate the code.
- No history in code: no run names, agent counts or measured timings in comments. Those go in
  [docs/design.md](docs/design.md) and commit messages.
- Prettier formats everything: tabs, double quotes, semicolons, lines under 120 characters (`npm run format`).
- A function does one thing and fits on a screen. A file holds one concern; split it past about 400 lines.
- Use full words for names that live more than a few lines, and the same name for the same thing everywhere.
- Turn a long expression into named steps. No nested ternaries.
- The dashboard (`web/`) draws only from its theme: see [docs/dashboard-ui.md](docs/dashboard-ui.md). A new color, or
  text on a new color, goes into the contrast test.

## Records, storage and migrations

Records in Git outlive the code that wrote them.

- To change a record's shape, bump `RECORD_FORMAT` in `src/record-format.ts`, add an upgrade from the old format, and
  pin the new shape with `UPDATE_RECORD_SHAPES=1 npx vitest run test/record-shapes.test.ts`.
- D1 migrations only add. The tests refuse one that drops, deletes or rewrites data.
- Durable Object classes aren't deleted or renamed without a migration in `wrangler.jsonc` and
  `wrangler.bench.jsonc`.

## Docs

When a change alters what people or agents see or do, update the docs with it. The docs site's pages in
`docs-site/src/content/docs/` are the source; the README only summarizes and links them. Design notes go in
[docs/design.md](docs/design.md), and the command line's guide is `cli/README.md`.

## Commits and pull requests

- A commit's first line says what changed for the people or agents using GitHive, as a plain sentence. For example:
  "A rejected change's fix is listed first for the reviewer that rejected it". The body says why.
- Keep a pull request to one change. Say how you tested it.

## Using AI tools

GitHive is built for coding agents, and much of it was written with them, so changes made with AI tools are welcome.

- Use a frontier model: Anthropic's latest Claude models, or one of comparable ability. Smaller models tend to miss
  the rules GitHive's records depend on.
- Read every line before you send it, and run the tests. You're responsible for the change, whoever wrote it.
- Say in the pull request when an agent wrote most of it, so reviewers know what to look for.
- Point your agent at this file and [docs/design.md](docs/design.md) before it starts.

## Code of conduct

Be kind and assume good intent. Criticize code, not people.

## License

GitHive is [MIT licensed](LICENSE). By contributing, you agree your contribution is released under the same license.
