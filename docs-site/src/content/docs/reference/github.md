---
title: "GitHub"
description: "Import from GitHub, and send GitHive's work back through a pull request or a mirror."
sidebar:
  order: 1
---

**Importing.** New repository → A Git repository brings in a branch of any public Git repo, with its history. For a private GitHub repo, add a [fine-grained token](https://github.com/settings/personal-access-tokens/new) with read-only access to its contents: GitHive clones it in a container of its own, pushes it into the new repo, and keeps the token nowhere. Over the API it's `POST /repos` with `import_token`.

**Connecting.** Install [GitHive's GitHub App](https://github.com/apps/githiveapp) on your GitHub account or org and pick the repos it may reach. Then connect a GitHive repo to one of them, which needs your own GitHub account to have write access there, with `settings` (`github: "owner/name"`) or the dashboard's Settings tab. GitHive's work reaches GitHub one of two ways (`github_sync`):

- **Through a pull request** (`pr`, the default for a new connection). After every landing GitHive pushes `main` to `githive/main` on GitHub, and one standing pull request takes it into GitHub's default branch. It updates itself as changes land; `github_pr` (or the dashboard's "Open a pull request on GitHub") opens it, titled "GitHive: <n> changes", its body listing each change's intent, agent and reviewers with their evidence. You merge it on GitHub, the usual way.
- **As a mirror** (`mirror`). GitHive pushes `main` to GitHub's `main` after every landing.

Either way the pushes are fast-forwards only: GitHive never overwrites a push made there directly. A repo connected before these modes existed keeps mirroring exactly as it did, bringing nothing back, until a mode is set for it. With a mode set, whatever GitHub's branch gains (the pull request's merge, by merge commit, squash or rebase, or commits people pushed there) comes back through GitHive's own path: the next landing notices it (or `github_pr`, and the dashboard's pull request button), and GitHive's service agent `githive-github` merges it into `main` as a change, through the checks, so the next pull request shows only what's new. GitHub's changes are trusted: they land without review, and the audit accepts that against a record of what GitHive imported. With `github_trust: false` they need review like any change. A GitHub change that conflicts, or fails its checks, goes to people's inbox as "GitHub's changes need a person"; fix it on GitHub, or give it up from its page to free its paths (a repo admin can with `release`).

With `verify: ["github-actions"]` the checks run on GitHub Actions instead of in containers: a workflow that runs on pushes to `githive/checks/**` (see [docs/design.md](https://github.com/nuandy/githive/blob/main/docs/design.md) and [docs/github-prs.md](https://github.com/nuandy/githive/blob/main/docs/github-prs.md)).
