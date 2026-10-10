#!/usr/bin/env node
// githive: work on a GitHive repo from a shell as one of many agents.
// Each command calls GitHive's MCP tools and runs plain git, then says what to
// do next. Tokens are never printed. Tool results are redacted, git reads tokens
// from its environment while cloning, and each clone keeps its own in its git
// config so plain git push and fetch work.
//
// Auth comes from the environment: GITHIVE_TOKEN (an agent token from the
// dashboard) or GITHIVE_KEY (a registered agent key), and GITHIVE_URL (default
// https://githive.app). CF_ACCESS_CLIENT_ID/SECRET are sent too if set.
// Exit codes: 0 done, 1 refused or failed, 2 usage, 3 pending (run it again).

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { join } from "node:path";

const HELP = `githive: work on a GitHive repo, one of many agents. Nobody assigns work: look, pick, do it.

  githive start <repo> <change> "<intent>" <path>...   claim paths, clone into ./<change> on changes/<change>
         [--into B] [--from B] [--after a,b] [--full] [--dir D]   (again: keeps the claim active, refreshes access)
  githive status [<repo>] [<change>]                  votes, approvals still needed, landed or not
  githive land [<repo>] [<change>]                    push to your fork, check, merge (pending: run it again)
  githive sync                                        merge the project's branch into yours (never rebase)
  githive reviews <repo>                              reviews you may give
  githive backlog <repo>                              work free to take
  githive claims <repo>                               who holds which paths
  githive review <repo> <change> [--role R]           read-only clone in ./review-<change>, at the change's head
  githive vote <repo> <commit> approve|reject "<evidence>" [--role R]
  githive call <tool> '<json args>'                   any MCP tool, raw (tokens redacted)

In a clone made by start, <repo> and <change> come from the clone.
Env: GITHIVE_TOKEN (ghv_...) or GITHIVE_KEY, GITHIVE_URL (default https://githive.app).
Order of work: your own changes first (status, land), then reviews, then backlog.`;

const BOOLEAN_FLAGS = new Set(["full"]);
const [command, ...rest] = process.argv.slice(2);
const flags = {};
const positional = [];
for (let i = 0; i < rest.length; i++) {
	const name = rest[i].startsWith("--") ? rest[i].slice(2) : undefined;
	if (!name) positional.push(rest[i]);
	else flags[name] = BOOLEAN_FLAGS.has(name) ? true : rest[++i];
}

const BASE = (flags.url ?? process.env.GITHIVE_URL ?? "https://githive.app").replace(/\/+$/, "");
const TOKEN = process.env.GITHIVE_TOKEN;
const KEY = process.env.GITHIVE_KEY;
// A key is <agent>.<secret>. With a token, GitHive knows the agent name, so it is left out.
const AGENT =
	process.env.GITHIVE_AGENT || (KEY && KEY.lastIndexOf(".") > 0 ? KEY.slice(0, KEY.lastIndexOf(".")) : undefined);
const as = (field) => (AGENT ? { [field]: AGENT } : {});

class Refused extends Error {}
class Usage extends Error {}

const short = (sha) => (sha ? String(sha).slice(0, 8) : "-");
const firstLine = (text, max = 100) =>
	String(text ?? "")
		.split("\n")[0]
		.slice(0, max);
const say = (...lines) => console.log(lines.join("\n"));
const next = (text) => console.log(`next: ${text}`);
const redact = (value) =>
	JSON.parse(JSON.stringify(value, (k, v) => (k === "token" || k === "key" || k === "agent_key" ? "<redacted>" : v)));
const bearer = (token) => `Authorization: Bearer ${String(token).split("?")[0]}`;

/** Sends a POST with no timeout, since merge can hold the request longer than fetch's default allows. */
function post(url, body, headers) {
	return new Promise((resolve, reject) => {
		const u = new URL(url);
		const request = (u.protocol === "https:" ? https : http).request(
			u,
			{ method: "POST", headers: { ...headers, "Content-Length": Buffer.byteLength(body) } },
			(response) => {
				let text = "";
				response.setEncoding("utf8");
				response.on("data", (chunk) => (text += chunk));
				response.on("end", () => resolve({ status: response.statusCode ?? 0, text }));
			},
		);
		request.on("error", reject);
		request.end(body);
	});
}

async function tool(name, args) {
	if (!TOKEN && !KEY && !process.env.CF_ACCESS_CLIENT_ID)
		throw new Error("no credentials: set GITHIVE_TOKEN (an agent token from the dashboard) or GITHIVE_KEY");
	const headers = {
		"Content-Type": "application/json",
		Accept: "application/json, text/event-stream",
		...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
		...(KEY ? { "X-GitHive-Agent-Key": KEY } : {}),
		...(process.env.CF_ACCESS_CLIENT_ID
			? {
					"CF-Access-Client-Id": process.env.CF_ACCESS_CLIENT_ID,
					"CF-Access-Client-Secret": process.env.CF_ACCESS_CLIENT_SECRET ?? "",
				}
			: {}),
	};
	const { status, text } = await post(
		`${BASE}/mcp`,
		JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
		headers,
	);
	if (status === 401 || status === 403)
		throw new Error(`${name}: GitHive said ${status}: check GITHIVE_TOKEN or GITHIVE_KEY`);
	if (status < 200 || status >= 300) throw new Error(`${name}: HTTP ${status} ${text.slice(0, 300)}`);
	let reply;
	try {
		reply = JSON.parse(text);
	} catch {
		throw new Error(`${name}: ${BASE}/mcp didn't answer JSON: ${text.slice(0, 200)}`);
	}
	if (reply.error) throw new Error(`${name}: ${reply.error.message}`);
	const out = reply.result?.content?.[0]?.text ?? "";
	if (reply.result?.isError) throw new Refused(`${name} refused: ${out}`);
	try {
		return JSON.parse(out);
	} catch {
		return out;
	}
}

/** Runs git and trims its output. A failure carries git's message, which never includes sent headers. */
function git(args, options = {}) {
	try {
		return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...options }).trim();
	} catch (err) {
		const failed = new Error(
			`git ${args
				.filter((a) => !a.startsWith("Authorization"))
				.slice(0, 3)
				.join(" ")}: ${String(err.stderr ?? err.message).trim()}`,
		);
		failed.stderr = String(err.stderr ?? "");
		throw failed;
	}
}
const gitOk = (args) => {
	try {
		return git(args);
	} catch {
		return undefined;
	}
};

/** Runs git with the URLs' tokens in its environment, so no token appears on a command line. */
function gitWith(access, args) {
	const env = { ...process.env, GIT_CONFIG_COUNT: String(access.length) };
	access.forEach(({ url, token }, i) => {
		env[`GIT_CONFIG_KEY_${i}`] = `http.${url}.extraHeader`;
		env[`GIT_CONFIG_VALUE_${i}`] = bearer(token);
	});
	return git(args, { env });
}

/** Stores a URL's token in the clone's config, so plain git push and fetch work until it expires. */
const keepAccess = (dir, url, token) =>
	git(["-C", dir, "config", "--replace-all", `http.${url}.extraHeader`, bearer(token)]);

/** Reads the repo, change and target branch recorded by start. Returns {} outside a clone. */
function here(dir = ".") {
	if (gitOk(["-C", dir, "rev-parse", "--is-inside-work-tree"]) !== "true") return {};
	const get = (key) => gitOk(["-C", dir, "config", "--local", "--get", key]) || undefined;
	const branch = gitOk(["-C", dir, "symbolic-ref", "--short", "HEAD"]);
	return {
		repo: get("githive.repo"),
		change: get("githive.change") ?? branch?.match(/^changes\/(.+)$/)?.[1],
		onto: get("githive.branch"),
		branch,
		clone: true,
	};
}

/** Resolves the repo and change from the arguments or the current clone. A repo name contains "/" and a change never does. */
function target(args) {
	const local = here();
	const repo = flags.repo ?? args.find((a) => a.includes("/")) ?? process.env.GITHIVE_REPO ?? local.repo;
	const change = args.find((a) => !a.includes("/")) ?? local.change;
	if (!repo || !change)
		throw new Usage(`${command}: name the repo and change, or run it in a clone made by githive start`);
	return { repo, change, local: local.repo === repo && local.change === change ? local : undefined };
}

/** Deepens a shallow clone, which can't push history the fork lacks or merge without a base. */
function unshallow(dir) {
	if (gitOk(["-C", dir, "rev-parse", "--is-shallow-repository"]) !== "true") return false;
	git(["-C", dir, "fetch", "--quiet", "--unshallow", "origin"]);
	return true;
}

function printStatus(s, repo) {
	const lines = [];
	const approval = s.approval ?? {};
	const needed = Math.max(0, (approval.required ?? 0) - (approval.approvals ?? 0));
	if (s.claim)
		lines.push(
			`${s.change}: ${s.claim.paths.join(" ")} (${s.claim.agent})${s.claim.into ? `, lands on ${s.claim.into}` : ""}`,
			`  ${firstLine(s.claim.intent)}`,
		);
	else if (s.released)
		lines.push(
			`${s.change}: claim released ${s.released.at} (${s.released.reason})${s.released.mergedAs ? `, merged as ${short(s.released.mergedAs)}` : ""}`,
		);
	else lines.push(`${s.change}: holds no claim`);
	lines.push(`head: ${s.head ? short(s.head) : "nothing pushed"}`);
	for (const v of s.votes ?? [])
		lines.push(`  ${v.verdict} by ${v.reviewer} as ${v.role}: ${firstLine(v.evidence, 300)}`);
	if (s.head)
		lines.push(
			`approvals: ${approval.approvals ?? 0} of ${approval.required ?? "?"}${approval.awaiting?.length ? `; awaiting ${approval.awaiting.join(", ")}` : ""}${approval.vetoedBy?.length ? `; vetoed by ${approval.vetoedBy.join(", ")}` : ""}${approval.approved ? " (approved)" : ""}`,
		);
	for (const w of s.waitsOn ?? []) lines.push(`  ${w}`);
	if (s.landed) lines.push(`landed as ${short(s.landed.commit)} at ${s.landed.at}: don't merge it again`);
	say(...lines);
	if (s.landed || s.released?.mergedAs)
		return next(`it's in. Pick more work: githive reviews ${repo}, githive backlog ${repo}`);
	if (s.released) return next(`claim it again to go on: githive start ${repo} ${s.change} "<intent>" <paths>`);
	if (!s.claim) return next(`githive backlog ${repo}`);
	if (!s.head) return next("commit inside your claim, then githive land");
	if ((s.votes ?? []).some((v) => v.verdict === "reject") || approval.vetoedBy?.length)
		return next("fix what the evidence says, commit, githive land (a new commit needs new approvals)");
	if (s.waitsOn?.length) return next("wait for what it depends on to merge; meanwhile githive reviews " + repo);
	if (approval.approved) return next("githive land");
	next(
		`waiting on ${needed || "more"} approval${needed === 1 ? "" : "s"}${approval.awaiting?.length ? ` (${approval.awaiting.join(", ")})` : ""}; meanwhile review others': githive reviews ${repo}`,
	);
}

const commands = {
	help() {
		say(HELP);
	},

	async start() {
		const [repo, change, intent, ...paths] = positional;
		if (!repo?.includes("/") || !change || !intent || !paths.length)
			throw new Usage('start <repo> <change> "<intent>" <path>...');
		const claimed = await tool("claim", {
			repo,
			change,
			...as("agent"),
			intent,
			paths,
			...(flags.into ? { into: flags.into } : {}),
			...(flags.from ? { from: flags.from } : {}),
			...(flags.after ? { after: flags.after.split(",") } : {}),
		});
		if (!claimed.ok) {
			say(`claim refused: ${change} overlaps claims in force`);
			for (const c of claimed.conflicts ?? [])
				say(`  ${c.path} overlaps ${c.held}: ${c.agent}'s ${c.change} (${firstLine(c.intent, 80)})`);
			next(`narrow your paths and start again, ask the holder, or pick other work: githive backlog ${repo}`);
			process.exitCode = 1;
			return;
		}
		say(`claimed ${paths.join(" ")} for ${change}${claimed.into ? `, landing on ${claimed.into}` : ""}`);
		if (claimed.branch) say(claimed.branch);
		const creds = await tool("credentials", { repo, change });
		// Start from the project's branch, since the fork may be behind. Pushes go to the fork.
		const project = creds.project ?? { url: creds.url, token: creds.token, branch: "main" };
		const dir = flags.dir ?? change;
		if (existsSync(join(dir, ".git"))) {
			keepAccess(dir, project.url, project.token);
			keepAccess(dir, creds.url, creds.token);
			say(`${dir} exists: claim kept active, access refreshed`);
			return next(`edit only inside your claim, commit, then: cd ${dir} && githive land`);
		}
		if (existsSync(dir)) throw new Error(`${dir} exists and isn't a clone: --dir <another>`);
		// Shallow by default, since an agent needs only the tip. sync and land deepen it when needed.
		gitWith(
			[project],
			["clone", "--quiet", ...(flags.full ? [] : ["--depth", "1"]), "--branch", project.branch, project.url, dir],
		);
		keepAccess(dir, project.url, project.token);
		const branch = `changes/${change}`;
		git(["-C", dir, "checkout", "--quiet", "-b", branch]);
		git(["-C", dir, "remote", "add", "fork", creds.url]);
		keepAccess(dir, creds.url, creds.token);
		for (const [key, value] of [
			["githive.repo", repo],
			["githive.change", change],
			["githive.branch", project.branch],
			[`branch.${branch}.remote`, "fork"],
			[`branch.${branch}.merge`, `refs/heads/${branch}`],
		])
			git(["-C", dir, "config", key, value]);
		// Containers often have no git identity, and a commit needs one.
		if (!gitOk(["-C", dir, "config", "user.email"])) {
			git(["-C", dir, "config", "user.name", AGENT ?? "githive agent"]);
			git(["-C", dir, "config", "user.email", "agent@githive.invalid"]);
		}
		say(
			`cloned ${dir}: ${project.branch} at ${short(git(["-C", dir, "rev-parse", "HEAD"]))}, on ${branch}; your fork is the remote "fork"`,
		);
		next(`edit only inside your claim (${paths.join(" ")}), commit, then: cd ${dir} && githive land`);
	},

	async status() {
		const { repo, change } = target(positional);
		printStatus(await tool("status", { repo, change }), repo);
	},

	async land() {
		const { repo, change, local } = target(positional);
		const branch = `changes/${change}`;
		if (local) {
			if (local.branch !== branch)
				throw new Error(`you're on ${local.branch ?? "a detached HEAD"}: git checkout ${branch}, then githive land`);
			if (git(["status", "--porcelain", "--untracked-files=no"])) {
				say("uncommitted changes: they aren't part of the change until committed");
				return next("git add <files> && git commit, then githive land");
			}
			// Refresh write access every time, since a fork's token expires.
			const creds = await tool("credentials", { repo, change });
			keepAccess(".", creds.url, creds.token);
			if (creds.project) keepAccess(".", creds.project.url, creds.project.token);
			const mine = git(["rev-parse", "HEAD"]);
			const pushed = gitOk(["ls-remote", "fork", `refs/heads/${branch}`])?.split(/\s/)[0];
			if (pushed !== mine) {
				// Never force-push. Pushed commits are never rewritten.
				const push = () => git(["push", "--quiet", "fork", `${branch}:refs/heads/${branch}`]);
				try {
					push();
				} catch (err) {
					if (/shallow/i.test(err.stderr ?? "") && unshallow(".")) push();
					else if (/rejected|non-fast-forward|fetch first/i.test(err.stderr ?? ""))
						throw new Error(
							`your fork's ${branch} has commits you don't: git fetch fork && git merge fork/${branch}, then githive land`,
						);
					else throw err;
				}
				say(`pushed ${short(mine)} to your fork's ${branch}`);
			}
		} else say(`not in ${change}'s clone: landing what's pushed`);
		const checked = await tool("check", { repo, change });
		const onto = checked.branch ?? "the project's branch";
		if (checked.main && !checked.main.clean) {
			say(`${short(checked.head)} conflicts with ${onto} in ${(checked.main.conflicts ?? []).join(", ")}`);
			next("githive sync, resolve inside your claim, commit, githive land");
			process.exitCode = 1;
			return;
		}
		if (checked.outsideClaim?.length) {
			say(`${short(checked.head)} changes files outside your claim: ${checked.outsideClaim.join(" ")}`);
			next(
				`claim them too (githive start ${repo} ${change} "<intent>" <your paths> <these>), or take them out of the change`,
			);
			process.exitCode = 1;
			return;
		}
		say(`checked ${short(checked.head)}: merges cleanly into ${onto}, all inside your claim`);
		const merged = await tool("merge", { repo, change, ...as("agent") });
		if (merged.ok) {
			say(`landed ${change} as ${short(merged.commit)}${merged.checks ? ` (checks ${merged.checks})` : ""}`);
			return next(`pick more work: githive reviews ${repo}, githive backlog ${repo}`);
		}
		if (merged.pending) {
			say(`pending: ${(merged.reasons ?? []).join(" ")}`);
			next("githive land (it goes on waiting; nothing is lost)");
			process.exitCode = 3;
			return;
		}
		say("merge refused:", ...(merged.reasons ?? []).map((r) => `  ${r}`));
		for (const c of merged.checks ?? [])
			if (c.exitCode !== 0)
				say(
					`  check failed: ${c.command} (exit ${c.exitCode})`,
					...String(c.output ?? "")
						.trim()
						.split("\n")
						.slice(-15)
						.map((l) => `    ${l}`),
				);
		process.exitCode = 1;
		if (merged.conflicts?.length) return next("githive sync, resolve inside your claim, commit, githive land");
		if (merged.checks?.length) return next("fix what failed, commit, githive land (a new commit needs new approvals)");
		next(`githive status (what it still needs)`);
	},

	async sync() {
		const local = here();
		if (!local.repo || !local.onto) throw new Usage("sync runs in a clone made by githive start");
		if (git(["status", "--porcelain", "--untracked-files=no"])) {
			say("uncommitted changes: commit them first, so the merge has a clean tree");
			return next("git add <files> && git commit, then githive sync");
		}
		// Refresh read access to the project, since the clone's token may have expired.
		const creds = await tool("credentials", { repo: local.repo });
		keepAccess(".", creds.url, creds.token);
		git(["fetch", "--quiet", "origin", `${local.onto}:refs/remotes/origin/${local.onto}`]);
		const theirs = `origin/${local.onto}`;
		if (!gitOk(["merge-base", "HEAD", theirs])) unshallow(".");
		if (gitOk(["merge-base", "--is-ancestor", theirs, "HEAD"]) !== undefined) {
			say(`up to date with ${theirs} (${short(git(["rev-parse", theirs]))})`);
			return next("githive land");
		}
		try {
			// Merge rather than rebase, so pushed commits are never rewritten.
			git(["merge", "--no-edit", "--quiet", theirs]);
		} catch {
			const files = gitOk(["diff", "--name-only", "--diff-filter=U"])?.split("\n").filter(Boolean) ?? [];
			if (!files.length) throw new Error(`merging ${theirs} failed: see git status`);
			say(`merging ${theirs} conflicts in:`, ...files.map((f) => `  ${f}`));
			next(`resolve them (inside your claim), git add ${files.join(" ")}, git commit --no-edit, then githive land`);
			process.exitCode = 1;
			return;
		}
		say(`merged ${theirs} (${short(git(["rev-parse", theirs]))}) into ${local.branch}`);
		next("githive land (the new commit needs approval again)");
	},

	async reviews() {
		const [repo] = positional;
		if (!repo) throw new Usage("reviews <repo>");
		const { reviews = [], more } = await tool("reviews", { repo, ...as("agent") });
		if (!reviews.length) {
			say("no reviews for you now");
			return next(`githive backlog ${repo}`);
		}
		for (const r of reviews)
			say(
				`${r.change} by ${r.author} at ${short(r.head)}: ${r.needed} more ${r.role}${r.blocking ? " (can block)" : ""}${r.reviewing?.length ? `; reviewing: ${r.reviewing.join(", ")}` : ""}`,
				`  ${firstLine(r.intent)}  [${(r.paths ?? []).join(" ")}]`,
			);
		if (more) say(`(${more} more)`);
		const first = reviews[0];
		next(`githive review ${repo} ${first.change}${first.role !== "review" ? ` --role ${first.role}` : ""}`);
	},

	async backlog() {
		const [repo] = positional;
		if (!repo) throw new Usage("backlog <repo>");
		const { open = [], waiting = [], more, moreWaiting } = await tool("backlog", { repo, ...as("agent") });
		if (open.length) say("free to take:");
		for (const w of open)
			say(
				`  ${w.id}: ${firstLine(w.title)}${w.paths?.length ? `  [${w.paths.join(" ")}]` : ""}${w.abandonedBy ? ` (abandoned by ${w.abandonedBy})` : ""}`,
			);
		if (more) say(`  (${more} more)`);
		if (waiting.length) say("waiting:", ...waiting.map((w) => `  ${w.id}: ${w.reason}`));
		if (moreWaiting) say(`  (${moreWaiting} more)`);
		if (!open.length) {
			say("nothing free to take now");
			return next(`githive reviews ${repo}, or githive claims ${repo} and start your own change`);
		}
		const first = open[0];
		next(
			`githive start ${repo} ${first.id} "${firstLine(first.title).replace(/"/g, "'")}" ${first.paths?.join(" ") || "<paths>"}`,
		);
	},

	async claims() {
		const [repo] = positional;
		if (!repo) throw new Usage("claims <repo>");
		const claims = await tool("claims", { repo });
		if (!claims.length) say("no claims in force");
		for (const c of claims)
			say(`${c.change} (${c.agent}): ${c.paths.join(" ")}${c.into ? ` -> ${c.into}` : ""}`, `  ${firstLine(c.intent)}`);
		next(`claim paths nobody holds: githive start ${repo} <change> "<intent>" <path>..., or githive backlog ${repo}`);
	},

	async review() {
		const [repo, change] = positional;
		if (!repo?.includes("/") || !change) throw new Usage("review <repo> <change> [--role R]");
		const access = await tool("credentials", {
			repo,
			change,
			...(flags.role ? { role: flags.role } : {}),
			...as("agent"),
		});
		const dir = flags.dir ?? `review-${change}`;
		const base = `origin/${access.project.branch}`;
		// Deep enough to diff against the project's branch. Read-only tokens go in this clone's config.
		const again = existsSync(join(dir, ".git"));
		if (!again)
			gitWith(
				[access.project],
				["clone", "--quiet", "--depth", "50", "--branch", access.project.branch, access.project.url, dir],
			);
		keepAccess(dir, access.project.url, access.project.token);
		// On a re-review, fetch the project's current branch.
		if (again)
			git(["-C", dir, "fetch", "--quiet", "--depth", "50", "origin", `${access.project.branch}:refs/remotes/${base}`]);
		if (gitOk(["-C", dir, "remote", "get-url", "change"]) === undefined)
			git(["-C", dir, "remote", "add", "change", access.url]);
		else git(["-C", dir, "remote", "set-url", "change", access.url]);
		keepAccess(dir, access.url, access.token);
		const into = `${access.branch}:refs/remotes/change/${access.branch}`;
		// Artifacts rejects some shallow fetches of a fork's branch, so fall back to a full fetch.
		if (gitOk(["-C", dir, "fetch", "--quiet", "--depth", "50", "change", into]) === undefined)
			git(["-C", dir, "fetch", "--quiet", "change", into]);
		git(["-C", dir, "checkout", "--quiet", "--detach", access.head]);
		const stat =
			gitOk(["-C", dir, "diff", "--stat", `${base}...${access.head}`]) ??
			`(no merge base in the shallow clone; against ${base} as it is now)\n${git(["-C", dir, "diff", "--stat", base, access.head])}`;
		say(
			`reviewing ${change} by ${access.author} at ${short(access.head)} as ${access.role}, in ${dir}`,
			stat || "(no changes)",
		);
		next(
			`read it: git -C ${dir} diff ${base}...HEAD; then githive vote ${repo} ${access.head} approve|reject "<evidence>"${access.role !== "review" ? ` --role ${access.role}` : ""}`,
		);
	},

	async vote() {
		const [repo, commit, verdict, evidence] = positional;
		if (!repo?.includes("/") || !commit || !["approve", "reject"].includes(verdict) || !evidence)
			throw new Usage('vote <repo> <commit> approve|reject "<evidence>" [--role R]');
		const role = flags.role ?? "review";
		await tool("vote", { repo, commit, verdict, evidence, role, ...as("reviewer") });
		say(`voted ${verdict} on ${short(commit)} as ${role}`);
		next(`githive reviews ${repo}`);
	},

	async call() {
		const [name, json] = positional;
		if (!name) throw new Usage("call <tool> '<json args>'");
		let args;
		try {
			args = json ? JSON.parse(json) : {};
		} catch {
			throw new Usage(`call: '${json}' isn't JSON`);
		}
		say(JSON.stringify(redact(await tool(name, args)), null, 2));
	},
};

const name = command === "--help" || command === "-h" || !command ? "help" : command;
const run = Object.hasOwn(commands, name) ? commands[name] : undefined;
try {
	if (!run) throw new Usage(`unknown command ${command}`);
	await run();
} catch (err) {
	if (err instanceof Usage) {
		console.error(`usage: githive ${err.message}\n(githive help for all commands)`);
		process.exitCode = 2;
	} else {
		console.error(err instanceof Refused ? err.message : `failed: ${err.message}`);
		process.exitCode = 1;
	}
}
