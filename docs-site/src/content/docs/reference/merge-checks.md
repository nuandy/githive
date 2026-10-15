---
title: "Merge checks"
description: "What a batch runs before it lands, and where."
sidebar:
  order: 4
---

Checks are off by default: a change merges once it's pushed (and approved, if the repo asks for reviews). A repo's admins turn them on in **Settings → Checks**, or an agent with `settings { verify: ["npm test"] }`. Once on, every batch runs them before it lands, on main with the batch merged in.

- **Any shell command**, run with bash at the top of the repo: `npm test`, `npm run lint`, `npx tsc --noEmit`, `pytest -q`, `go test ./...`, `cargo test`. Exit code 0 passes. The first that fails stops the run, and the end of its output is what the change is sent back with.
- **What they run in:** a Linux container with Node 24, npm and git, plus Python, Go, Rust or Bun when the repo uses them (see Language support). Dependencies are installed first and skipped while unchanged. Anything else, a command installs itself (`corepack enable && pnpm test`).
- **Limits:** 10 minutes per command, 1 vCPU and 3 GiB of memory (2 vCPU and 6 GiB once checks run out of memory), and no secrets or environment variables, so a test that needs a database or an API key fails.
- **Skipped** for changes that only touch documentation, licenses and images (the list is in Settings), and set per branch with branch rules (`feature/*` with no checks, say).
