#!/usr/bin/env node
// Seed demo repos for the dashboard (and the video), one per mode, with changes
// in every state a person would see on a pull request list.
//
// <repo>: open mode, run by the elected coordinator. Blueprint's own reviewer
// agents review the finished changes, so their verdicts and evidence are real
// (this spends a few model calls). Two are sent back and revised, and one
// sent back is resubmitted unchanged, so it waits on a person; --only revise
// does that step again on an existing repo. Claims last a day (the most a
// repo allows), so seed on the day you show it.
// <repo>-free: coordinator-free mode. Agents with their own keys claim, push
// to their forks, vote and merge through the toolkit; no model calls.
//
//   node scripts/seed-demo.mjs [--base https://blueprint-bench.nuandy.workers.dev] [--repo demo-<time>] [--only open|free|revise]
//
// Credentials come from .dev.vars (CF_ACCESS_CLIENT_ID, CF_ACCESS_CLIENT_SECRET) and are never printed; nor are agent keys.

import fs from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import git from "isomorphic-git";
import http from "isomorphic-git/http/node";

const root = new URL("..", import.meta.url).pathname;
const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, arg, i, all) => (arg.startsWith("--") ? [...pairs, [arg.slice(2), all[i + 1]]] : pairs), []));
const BASE = args.base ?? "https://blueprint-bench.nuandy.workers.dev";
const REPO = args.repo ?? `demo-${Date.now().toString(36)}`;

const vars = Object.fromEntries((await readFile(join(root, ".dev.vars"), "utf8")).split("\n").map((l) => l.match(/^([A-Z_]+)=(.*)$/)).filter(Boolean).map(([, k, v]) => [k, v.replace(/^"|"$/g, "")]));
const headers = { "CF-Access-Client-Id": vars.CF_ACCESS_CLIENT_ID, "CF-Access-Client-Secret": vars.CF_ACCESS_CLIENT_SECRET, "Content-Type": "application/json" };

async function api(method, path, body) {
	const response = await fetch(`${BASE}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
	const text = await response.text();
	if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${text.slice(0, 300)}`);
	return JSON.parse(text);
}

/** A tool call, as the coordinator-free agent holding `key` (if any). */
async function tool(name, toolArgs, key) {
	const response = await fetch(`${BASE}/mcp`, {
		method: "POST",
		headers: { ...headers, ...(key ? { "X-Blueprint-Agent-Key": key } : {}) },
		body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: toolArgs } }),
	});
	if (!response.ok) throw new Error(`${name}: ${response.status} ${(await response.text()).slice(0, 300)}`);
	const reply = await response.json();
	const text = reply.result.content[0].text;
	if (reply.result.isError) throw new Error(`${name}: ${text}`);
	return JSON.parse(text);
}

const say = (...line) => console.log(...line);
const work = await mkdtemp(join(tmpdir(), "seed-demo-"));

/** Open a change, commit `edit` to its fork, push and report it. */
async function change(taskId, { title, intent, paths, agent, edit }) {
	const opened = await tool("open_change", { task_id: taskId, title, intent, paths, agent });
	const dir = join(work, opened.change_id);
	const onAuth = () => ({ username: "x", password: opened.token.replace(/\?.*$/, "") });
	await git.clone({ fs, http, dir, url: opened.fork, depth: 1, singleBranch: true, onAuth });
	const files = await edit(dir);
	for (const [path, action] of Object.entries(files)) await (action === "remove" ? git.remove({ fs, dir, filepath: path }) : git.add({ fs, dir, filepath: path }));
	await git.commit({ fs, dir, message: title, author: { name: agent, email: `${agent}@example.com` } });
	await git.push({ fs, http, dir, url: opened.fork, ref: "main", onAuth });
	await tool("report_push", { task_id: taskId, change_id: opened.change_id });
	say(`  ${title}: ${opened.change_id}`);
	return opened.change_id;
}

const write = (dir, path, text) => {
	fs.mkdirSync(join(dir, path, ".."), { recursive: true });
	fs.writeFileSync(join(dir, path), text);
	return { [path]: "add" };
};

async function seedOpen() {
	say(`open mode: ${REPO} on ${BASE}`);
	await api("POST", "/repos/import", { url: "https://github.com/octocat/Spoon-Knife", name: REPO, branch: "main" });
	// Claims last a day without activity (the most allowed), so the demo holds still for a while.
	await api("POST", `/repos/${REPO}/open`, { leaseMinutes: 1440 });
	const { task_id: taskId } = await tool("join_repo", { repo: REPO });
	say(`task ${taskId}`);

	const contributing = await change(taskId, {
		title: "Add a contributing guide",
		intent: "Explain how to fork the repo and open a pull request.",
		paths: ["CONTRIBUTING.md"],
		agent: "docs-agent",
		edit: (dir) => write(dir, "CONTRIBUTING.md", "# Contributing\n\n1. Fork this repository.\n2. Make your change on a branch.\n3. Open a pull request describing what you changed and why.\n"),
	});
	const readme = await change(taskId, {
		title: "Clarify the README",
		intent: "Say what the repo is for in the README's first line.",
		paths: ["README.md"],
		agent: "readme-agent",
		edit: (dir) => write(dir, "README.md", "### Well hello there!\n\nThis repository is meant to provide an example for *forking* a repository on GitHub.\n\nCreating a *fork* is producing a personal copy of someone else's project. Forks act as a sort of bridge between the original repository and your personal copy.\n"),
	});
	const homepage = await change(taskId, {
		title: "Clean up the site",
		intent: "Tidy the site files.",
		paths: ["index.html"],
		agent: "site-agent",
		edit: async (dir) => {
			fs.rmSync(join(dir, "index.html"));
			return { "index.html": "remove" };
		},
	});
	const styles = await change(taskId, {
		title: "Center the page title",
		intent: "Center the heading on the page.",
		paths: ["styles.css"],
		agent: "style-agent",
		edit: (dir) => write(dir, "styles.css", "* {\n  margin: 0;\n  padding: 0;\n}\n\nh1 {\n  text-align: center;\n}\n"),
	});
	await change(taskId, {
		title: "Add a dark mode",
		intent: "Respect the reader's dark-mode preference.",
		paths: ["dark.css"],
		agent: "theme-agent",
		edit: (dir) => write(dir, "dark.css", "@media (prefers-color-scheme: dark) {\n  body { background: #111; color: #eee; }\n}\n"),
	});
	const experiment = await tool("open_change", { task_id: taskId, title: "Try a new layout", intent: "An experiment with the page layout.", paths: ["layout/"], agent: "layout-agent" });
	await tool("abandon_change", { task_id: taskId, change_id: experiment.change_id, reason: "Not needed after all." });
	say(`  Try a new layout: ${experiment.change_id} (abandoned)`);

	// Finished changes go to Blueprint's reviewers; "Add a dark mode" stays a work in progress.
	for (const [id, summary] of [
		[contributing, "Adds CONTRIBUTING.md with the fork-and-pull-request steps."],
		[readme, "Rewrites the README's opening so it says what the repo is for."],
		[homepage, "Removes index.html to tidy the site."],
		[styles, "Centers the h1 in styles.css."],
	]) {
		const finished = await tool("finish_change", { task_id: taskId, change_id: id, summary });
		say(`  finished ${id}: ${finished.status}`);
	}
	await reviseOpen(taskId);
}

// The reviewers send the first drafts of the guide and the README back (they
// only name the steps; the first line is unchanged). Their agent revises both,
// so the dashboard shows a change sent back, fixed and merged.
const REVISIONS = {
	"Add a contributing guide": {
		message: "Explain each contributing step",
		summary: "Each step now says how to do it: fork on GitHub, clone the fork, branch, commit, push, and open the pull request against octocat/Spoon-Knife.",
		edit: (dir) => write(dir, "CONTRIBUTING.md", "# Contributing\n\n1. **Fork** this repository: click *Fork* at the top right of its GitHub page. You now have your own copy.\n2. **Clone** your fork: `git clone https://github.com/<you>/Spoon-Knife.git` and `cd Spoon-Knife`.\n3. **Branch**: `git switch -c my-change`.\n4. **Change and commit**: edit the files, stage only those you changed (`git add <file>`), check what you staged with `git diff --cached`, then `git commit -m \"Describe the change\"`.\n5. **Push** the branch to your fork: `git push -u origin my-change`.\n6. **Open a pull request**: on your fork's GitHub page, click *Compare & pull request*, check that the base is `octocat/Spoon-Knife` `main`, and describe what you changed and why.\n"),
	},
	"Clarify the README": {
		message: "State the repo's purpose in the first line",
		summary: "README.md's first line now says what the repo is for: a practice repository for learning to fork on GitHub.",
		edit: (dir) => write(dir, "README.md", "### A practice repository for learning to fork a project on GitHub.\n\nCreating a *fork* is producing a personal copy of someone else's project. Forks act as a sort of bridge between the original repository and your personal copy. You can submit *Pull Requests* to help make other people's projects better by offering your changes up to the original project.\n"),
	},
};

// The agent of this change insists instead of revising, so it waits on a person.
const INSIST = "Clean up the site";

/** Wait for the reviewers' verdicts, then revise the changes sent back that have a revision. */
async function reviseOpen(taskId) {
	say("  waiting for the reviewers' verdicts…");
	for (const deadline = Date.now() + 15 * 60_000; ; ) {
		const { slices } = await api("GET", `/tasks/${taskId}`).then((t) => t.task ?? t);
		const watched = (s) => (REVISIONS[s.title] || s.title === INSIST) && s.status === "building" && !s.attention;
		const pending = slices.filter((s) => watched(s) && (!s.reviewHead || s.reviewHead !== s.sentBackFor));
		const sentBack = slices.filter((s) => watched(s) && s.reviewHead && s.reviewHead === s.sentBackFor);
		if (!pending.length || Date.now() > deadline) {
			for (const s of sentBack) {
				if (REVISIONS[s.title]) await revise(taskId, s.id, REVISIONS[s.title]);
				else {
					// Sent back, it asks again without a new commit: a person decides.
					const again = await tool("finish_change", { task_id: taskId, change_id: s.id, summary: "Removing index.html is the tidy-up intended: the site moves elsewhere." });
					say(`  resubmitted ${s.id} unchanged: ${again.status}`);
				}
			}
			if (pending.length) say(`  gave up waiting on ${pending.map((s) => s.id).join(", ")}`);
			break;
		}
		await new Promise((resolve) => setTimeout(resolve, 15_000));
	}
	say(`Reviewers are at work on the revisions in ${REPO}; they should merge.`);
}

/** Push a revision of a change that was sent back, and ask for review again. */
async function revise(taskId, changeId, { message, summary, edit }) {
	const { fork, token } = await tool("refresh_credentials", { task_id: taskId, change_id: changeId });
	const dir = join(work, `${changeId}-revision`);
	const onAuth = () => ({ username: "x", password: token.replace(/\?.*$/, "") });
	await git.clone({ fs, http, dir, url: fork, depth: 1, singleBranch: true, onAuth });
	for (const path of Object.keys(await edit(dir))) await git.add({ fs, dir, filepath: path });
	await git.commit({ fs, dir, message, author: { name: "demo-agent", email: "demo-agent@example.com" } });
	await git.push({ fs, http, dir, url: fork, ref: "main", onAuth });
	await tool("report_push", { task_id: taskId, change_id: changeId });
	const finished = await tool("finish_change", { task_id: taskId, change_id: changeId, summary });
	say(`  revised ${changeId}: ${finished.status}`);
}

/** Coordinator-free: claim, push the change to its own fork, and return its head. */
async function freeChange(repo, agent, { change, intent, paths, edit }) {
	await tool("free_claim", { repo, change, agent: agent.name, paths, intent }, agent.key);
	const fork = await tool("free_credentials", { repo, change }, agent.key);
	const dir = join(work, `${repo}-${change}`);
	const onAuth = () => ({ username: "x", password: fork.token.replace(/\?.*$/, "") });
	await git.clone({ fs, http, dir, url: fork.url, depth: 1, singleBranch: true, onAuth });
	for (const [path, action] of Object.entries(await edit(dir))) await (action === "remove" ? git.remove({ fs, dir, filepath: path }) : git.add({ fs, dir, filepath: path }));
	const head = await git.commit({ fs, dir, message: intent, author: { name: agent.name, email: `${agent.name}@example.com` } });
	await git.push({ fs, http, dir, url: fork.url, ref: "main", remoteRef: `refs/heads/changes/${change}`, onAuth });
	await tool("free_check", { repo, change }, agent.key);
	return head;
}

async function seedFree() {
	const repo = `${REPO}-free`;
	say(`\ncoordinator-free: ${repo} on ${BASE}`);
	await api("POST", "/repos/import", { url: "https://github.com/octocat/Spoon-Knife", name: repo, branch: "main" });
	await tool("free_start", { repo, required: 2, vetoes: ["security"], verify: ["test -f index.html"] });
	const agents = {};
	for (const name of ["docs-agent", "style-agent", "readme-agent", "theme-agent", "layout-agent", "tests-reviewer", "security-reviewer"]) agents[name] = { name, key: (await tool("free_register", { repo, agent: name })).key };
	const vote = (commit, reviewer, role, verdict, evidence) => tool("free_vote", { repo, commit, reviewer, role, verdict, evidence }, agents[reviewer].key);

	// Merged: both reviewers approve, the checks pass, and the toolkit merges it.
	const contributing = await freeChange(repo, agents["docs-agent"], {
		change: "contributing-guide",
		intent: "Add a contributing guide explaining how to fork and open a pull request",
		paths: ["CONTRIBUTING.md"],
		edit: (dir) => write(dir, "CONTRIBUTING.md", "# Contributing\n\n1. Fork this repository.\n2. Make your change on a branch.\n3. Open a pull request describing what you changed and why.\n"),
	});
	await vote(contributing, "tests-reviewer", "tests", "approve", "CONTRIBUTING.md renders; no code changed, index.html still present.");
	await vote(contributing, "security-reviewer", "security", "approve", "Documentation only; no scripts, links or secrets.");
	const merged = await tool("free_merge", { repo, change: "contributing-guide", agent: "docs-agent" }, agents["docs-agent"].key);
	say(`  contributing-guide: ${merged.ok ? "merged" : JSON.stringify(merged)}`);

	// Changes requested: the security reviewer vetoes it.
	const title = await freeChange(repo, agents["style-agent"], {
		change: "center-title",
		intent: "Center the page title",
		paths: ["styles.css"],
		edit: (dir) => write(dir, "styles.css", "@import url(http://example.com/fonts.css);\n\n* {\n  margin: 0;\n  padding: 0;\n}\n\nh1 {\n  text-align: center;\n}\n"),
	});
	await vote(title, "tests-reviewer", "tests", "approve", "The heading is centered; index.html still loads styles.css.");
	await vote(title, "security-reviewer", "security", "reject", "styles.css now imports a stylesheet over plain http from example.com, a third-party host; drop the import or serve the font locally.");
	say("  center-title: changes requested");

	// In review: one approval of the two required.
	const readme = await freeChange(repo, agents["readme-agent"], {
		change: "clarify-readme",
		intent: "Say what the repo is for in the README's first line",
		paths: ["README.md"],
		edit: (dir) => write(dir, "README.md", "### Well hello there!\n\nThis repository is meant to provide an example for *forking* a repository on GitHub.\n"),
	});
	await vote(readme, "tests-reviewer", "tests", "approve", "README only; nothing to run.");
	say("  clarify-readme: in review, one approval of two");

	// Working: claimed and pushed, not yet reviewed.
	await freeChange(repo, agents["theme-agent"], {
		change: "dark-mode",
		intent: "Respect the reader's dark-mode preference",
		paths: ["dark.css"],
		edit: (dir) => write(dir, "dark.css", "@media (prefers-color-scheme: dark) {\n  body { background: #111; color: #eee; }\n}\n"),
	});
	say("  dark-mode: in progress");

	// Abandoned: claimed, then released.
	await tool("free_claim", { repo, change: "new-layout", agent: "layout-agent", paths: ["layout/"], intent: "Try a new page layout" }, agents["layout-agent"].key);
	await tool("free_release", { repo, change: "new-layout", agent: "layout-agent", reason: "Not needed after all." }, agents["layout-agent"].key);
	say("  new-layout: released");

	const audit = await tool("free_audit", { repo });
	say(`  audit: ${audit.merges} merge(s) on main, ${audit.open} open violations`);
}

try {
	if (args.only === "revise") await reviseOpen((await tool("join_repo", { repo: REPO })).task_id);
	else {
		if (args.only !== "free") await seedOpen();
		if (args.only !== "open") await seedFree();
	}
} finally {
	await rm(work, { recursive: true, force: true });
}
