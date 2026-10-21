---
title: "Develop"
description: "Tests, typechecks, and changing records and migrations."
sidebar:
  order: 5
---

```sh
npm test            # the full suite (unit tests)
npm run test:changed # only the tests touched by your changes since origin/dev
npm run test:related -- src/models/settings.ts   # the tests that import these files
npm run test:workerd # the tests that need workerd (test/workerd), apart from npm test
npm run test:soak   # a demo's whole life under a failing store: outside agents, then GitHive's own (about 3 min)
npm run typecheck
npm run types       # regenerate worker-configuration.d.ts after editing wrangler.jsonc
npm run ci:status   # whether the full suite passed on GitHub Actions for this commit
```

While working on a change, run the tests it touches (`test:changed`, `test:related`): seconds, where the full suite
takes minutes. The full suite runs on GitHub Actions for every push to `dev`
([`.github/workflows/test.yml`](https://github.com/nuandy/githive/blob/main/.github/workflows/test.yml)), so it's run once a commit rather than once a fix, and
two people's runs never slow each other down. Deploy a commit once its run has passed (`npm run ci:status`).

Records in Git outlive the code that wrote them. To change a record's shape, bump `RECORD_FORMAT` in `src/record-format.ts`, add an upgrade from the old format, and run `UPDATE_RECORD_SHAPES=1 npx vitest run test/record-shapes.test.ts` to pin the new shape. Database migrations only add: the tests refuse one that drops, deletes or rewrites data.

How to propose a change, name your branch and use AI tools is in
[CONTRIBUTING.md](https://github.com/nuandy/githive/blob/main/CONTRIBUTING.md). To report a vulnerability privately,
see [SECURITY.md](https://github.com/nuandy/githive/blob/main/SECURITY.md).
