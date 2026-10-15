---
title: "Language support"
description: "Which languages awareness reads."
sidebar:
  order: 5
---

Builders, reviewers and the checks run in Cloudflare's managed `cloudflare/debian-trixie` image, which has Node.js 24 and npm. On top of it, each container installs git and whichever toolchains the repo uses, read from its tracked files in any folder:

| Toolchain | Detected by | Installed | Dependencies |
|---|---|---|---|
| Python 3 | `pyproject.toml`, `requirements*.txt`, `setup.py`, `setup.cfg`, `uv.lock`, `Pipfile` | the system's `python3` and `uv`, with a virtualenv at `/opt/venv` | `uv sync` (or `uv pip install -r requirements*.txt`) |
| Go | `go.mod` | the latest release (`GOTOOLCHAIN` fetches a newer one a `go.mod` asks for) | `go mod download` |
| Rust | `Cargo.toml` | `rustup`, minimal profile with clippy and rustfmt (a `rust-toolchain.toml` is honoured) | `cargo fetch` |
| Bun | `bun.lock`, `bun.lockb`, `bunfig.toml` | the latest release, from Bun's install script | `bun install --frozen-lockfile` (or `bun install` without a lockfile), instead of npm |

The checks install dependencies before a repo's `verify` commands run, and skip that while the files they come from are unchanged. For Node, unless one of the checks installs (`npm ci`, `npm install`, or pnpm's, yarn's or bun's), a repo with a `package.json` gets `npm ci` from its npm lockfile, or `npm install` without one; a Bun repo gets `bun install` instead. A failed install fails the check, with its output. Toolchains install outside the checkout, so they survive between checks in a running container, and the repo's snapshot carries them to new ones. Other languages (Java, .NET, Ruby, Swift) aren't installed; iOS apps can't be built at all, since Xcode runs only on macOS.
