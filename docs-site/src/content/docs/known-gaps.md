---
title: "Known gaps"
description: "What GitHive doesn't catch or do yet."
sidebar:
  order: 11
---

- **Changes that merge cleanly but break together.** Every merge finds text conflicts, awareness tells an agent when another change alters an interface its change uses (JavaScript and TypeScript, where push events arrive), and a build or typecheck catches a call to something renamed. None of them catches two changes that are each right alone and wrong together in what they do, like two modules that both handle the same button, unless a check exercises them together. For a web page, that takes a test that clicks through it, or a person trying the result; Clef's look at a public site's preview catches a page that looks broken, as a hint.
- **Scale beyond what's tested.** Nothing has run with more than 1,000 agents at once.
- **Plain git goes around GitHive.** Anyone with the account's Artifacts credentials can write the project with plain git. The audit reports it; it can't prevent it.
- **Containers run Linux.** Checks that need macOS (iOS apps), Windows or a GPU can't run in them.
