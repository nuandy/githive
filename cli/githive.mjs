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
for (let index = 0; index < rest.length; index++) {
	const name = rest[index].startsWith("--") ? rest[index].slice(2) : undefined;
	if (!name) positional.push(rest[index]);
	else flags[name] = BOOLEAN_FLAGS.has(name) ? true : rest[++index];
}

const BASE = (flags.url ?? process.env.GITHIVE_URL ?? "https://githive.app").replace(/\/+$/, "");
const TOKEN = process.env.GITHIVE_TOKEN;
const KEY = process.env.GITHIVE_KEY;
// A key is <agent>.<secret>. With a token, GitHive knows the agent name, so it is left out.
const keyDot = KEY ? KEY.lastIndexOf(".") : -1;
const AGENT = process.env.GITHIVE_AGENT || (keyDot > 0 ? KEY.slice(0, keyDot) : undefined);
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
/**
 * The next step in the CLI's own commands, after the commands in `fix` (the reply's, by default) that resolve it with
 * plain git. `own` may be a function of whether a fix was printed, so that its step continues that recipe rather than
 * give a second one. GitHive's next, in its tool words, only where the CLI has nothing of its own, else `otherwise`.
 */
function follow(reply, own, { fix = reply?.fix, otherwise } = {}) {
	const fixed = printFix(fix);
	const theirs = typeof reply?.next === "string" && reply.next.trim() ? reply.next : undefined;
	const step = (typeof own === "function" ? own(fixed) : own) || theirs || otherwise;
	if (step) next(step);
}

/**
 * A reply's fix as plain git to run in the clone, leaving out its tool words, which the next step says the CLI's way.
 * A shallow clone (start's default) is deepened first, as githive sync does, so the merge finds its base. Returns
 * whether it printed any commands.
 */
function printFix(fix) {
	const commands = Array.isArray(fix)
		? fix.filter((line) => typeof line === "string" && !line.startsWith("call "))
		: [];
	if (!commands.length) return false;
	const deepen = gitOk(["rev-parse", "--is-shallow-repository"]) === "true" ? ["git fetch --unshallow origin"] : [];
	say("with plain git, in your clone:", ...[...deepen, ...commands].map((line) => `  ${line}`));
	return true;
}
const SECRET_FIELDS = new Set(["token", "key", "agent_key"]);
const redact = (value) =>
	JSON.parse(JSON.stringify(value, (field, inner) => (SECRET_FIELDS.has(field) ? "<redacted>" : inner)));
const bearer = (token) => `Authorization: Bearer ${String(token).split("?")[0]}`;

/** Sends a POST with no timeout, since merge can hold the request longer than fetch's default allows. */
function post(url, body, headers) {
	return new Promise((resolve, reject) => {
		const target = new URL(url);
		const transport = target.protocol === "https:" ? https : http;
		const request = transport.request(
			target,
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

/** Who is calling: an agent token, an agent key, and Cloudflare Access credentials, whichever are set. */
function authHeaders() {
	const headers = {};
	if (TOKEN) headers.Authorization = `Bearer ${TOKEN}`;
	if (KEY) headers["X-GitHive-Agent-Key"] = KEY;
	if (process.env.CF_ACCESS_CLIENT_ID) {
		headers["CF-Access-Client-Id"] = process.env.CF_ACCESS_CLIENT_ID;
		headers["CF-Access-Client-Secret"] = process.env.CF_ACCESS_CLIENT_SECRET ?? "";
	}
	return headers;
}

async function tool(name, args) {
	if (!TOKEN && !KEY && !process.env.CF_ACCESS_CLIENT_ID)
		throw new Error("no credentials: set GITHIVE_TOKEN (an agent token from the dashboard) or GITHIVE_KEY");
	const headers = {
		"Content-Type": "application/json",
		Accept: "application/json, text/event-stream",
		...authHeaders(),
	};
	const request = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } };
	const { status, text } = await post(`${BASE}/mcp`, JSON.stringify(request), headers);
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
	const output = reply.result?.content?.[0]?.text ?? "";
	if (reply.result?.isError) throw new Refused(`${name} refused: ${output}`);
	try {
		return JSON.parse(output);
	} catch {
		return output;
	}
}

/** Runs git and trims its output. A failure carries git's message, which never includes sent headers. */
function git(args, options = {}) {
	try {
		return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...options }).trim();
	} catch (err) {
		const shown = args
			.filter((arg) => !arg.startsWith("Authorization"))
			.slice(0, 3)
			.join(" ");
		const failed = new Error(`git ${shown}: ${String(err.stderr ?? err.message).trim()}`);
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
	access.forEach(({ url, token }, index) => {
		env[`GIT_CONFIG_KEY_${index}`] = `http.${url}.extraHeader`;
		env[`GIT_CONFIG_VALUE_${index}`] = bearer(token);
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

/**
 * Resolves the repo and change from the arguments or the current clone. A repo name contains "/" and a change
 * never does.
 */
function target(args) {
	const local = here();
	const repo = flags.repo ?? args.find((arg) => arg.includes("/")) ?? process.env.GITHIVE_REPO ?? local.repo;
	const change = args.find((arg) => !arg.includes("/")) ?? local.change;
	if (!repo || !change)
		throw new Usage(`${command}: name the repo and change, or run it in a clone made by githive start`);
	const inThisClone = local.repo === repo && local.change === change;
	return { repo, change, local: inThisClone ? local : undefined };
}

/** Deepens a shallow clone, which can't push history the fork lacks or merge without a base. */
function unshallow(dir) {
	if (gitOk(["-C", dir, "rev-parse", "--is-shallow-repository"]) !== "true") return false;
	git(["-C", dir, "fetch", "--quiet", "--unshallow", "origin"]);
	return true;
}

/** The line saying what a change holds: its claim, a released claim, or nothing. */
function claimLines(status) {
	const { claim, released } = status;
	if (claim) {
		const landsOn = claim.into ? `, lands on ${claim.into}` : "";
		return [`${status.change}: ${claim.paths.join(" ")} (${claim.agent})${landsOn}`, `  ${firstLine(claim.intent)}`];
	}
	if (released) {
		const mergedAs = released.mergedAs ? `, merged as ${short(released.mergedAs)}` : "";
		return [`${status.change}: claim released ${released.at} (${released.reason})${mergedAs}`];
	}
	return [`${status.change}: holds no claim`];
}

function approvalLine(approval) {
	const awaiting = approval.awaiting?.length ? `; awaiting ${approval.awaiting.join(", ")}` : "";
	const vetoed = approval.vetoedBy?.length ? `; vetoed by ${approval.vetoedBy.join(", ")}` : "";
	const approved = approval.approved ? " (approved)" : "";
	return `approvals: ${approval.approvals ?? 0} of ${approval.required ?? "?"}${awaiting}${vetoed}${approved}`;
}

/** What to do next about a change, from its status, in the CLI's commands, with the commands that resolve a conflict. */
function nextForStatus(status, repo) {
	follow(status, statusStep(status, repo), { fix: status.merge?.clean === false ? status.merge.fix : undefined });
}

function statusStep(status, repo) {
	const approval = status.approval ?? {};
	if (status.landed || status.released?.mergedAs)
		return `it's in. Pick more work: githive reviews ${repo}, githive backlog ${repo}`;
	if (status.released) return `claim it again to go on: githive start ${repo} ${status.change} "<intent>" <paths>`;
	if (!status.claim) return `githive backlog ${repo}`;
	if (!status.head) return "commit inside your claim, then githive land";
	// The test merge first: a conflict or a file outside the claim needs a new commit, whatever the votes say.
	const merge = status.merge ?? {};
	if (merge.clean === false) return resolveConflict;
	if (merge.outsideClaim?.length) return claimThemToo(repo, status.change);
	const rejected = (status.votes ?? []).some((vote) => vote.verdict === "reject");
	if (rejected || approval.vetoedBy?.length) return FIX_EVIDENCE;
	if (status.waitsOn?.length) return WAIT_FOR_DEPENDENCIES(repo);
	if (approval.approved) return "githive land";
	const needed = Math.max(0, (approval.required ?? 0) - (approval.approvals ?? 0));
	const plural = needed === 1 ? "" : "s";
	const awaiting = approval.awaiting?.length ? ` (${approval.awaiting.join(", ")})` : "";
	return `waiting on ${needed || "more"} approval${plural}${awaiting}; meanwhile review others': githive reviews ${repo}`;
}

const RESOLVE_CONFLICT = "githive sync, resolve inside your claim so both changes make sense, commit, githive land";
/** After the reply's fix, the step goes on from its commands rather than start over with githive sync. */
const AFTER_FIX =
	"run the commands above, resolving inside your claim so both changes make sense, then: githive land (the new " +
	"commit needs approval again)";
const resolveConflict = (fixed) => (fixed ? AFTER_FIX : RESOLVE_CONFLICT);
const FIX_EVIDENCE = "fix what the evidence says, commit, githive land (a new commit needs new approvals)";
const WAIT_FOR_DEPENDENCIES = (repo) => `wait for what it depends on to merge; meanwhile githive reviews ${repo}`;
const claimThemToo = (repo, change) =>
	`claim them too (githive start ${repo} ${change} "<intent>" <your paths> <these>), or take them out of the change`;

// What a refused merge needs, in the CLI's commands, for each kind of reason it has (the reply's why).
const REFUSED = {
	conflict: (_repo, _change, fixed) => resolveConflict(fixed),
	checks: () => "fix what failed, commit, githive land (a new commit needs new approvals)",
	"changes-asked": () => FIX_EVIDENCE,
	outside: (repo, change) => claimThemToo(repo, change),
	inside: (repo) =>
		`take the files inside others' claims out of the change, or wait until those claims are released ` +
		`(githive claims ${repo})`,
	unclaimed: (repo, change) => `claim it again: githive start ${repo} ${change} "<intent>" <paths>, then githive land`,
	approvals: (repo) => `wait for approvals (githive status says how many); meanwhile githive reviews ${repo}`,
	after: (repo) => `${WAIT_FOR_DEPENDENCIES(repo)}, then githive land`,
	moved: () => "githive land",
	unread: () => "githive land (it pushes your branch to your fork if it's missing there)",
};

/**
 * The CLI's steps for a refused merge, from its why, or from its fields when it has none, as a function of whether the
 * reply's fix was printed (see follow); undefined if it has none.
 */
function refusedStep(merged, repo, change) {
	const kinds = new Set((merged.why ?? []).filter((kind) => Object.hasOwn(REFUSED, kind)));
	if (!merged.why?.length) {
		if (merged.conflicts?.length) kinds.add("conflict");
		if ((merged.checks ?? []).some((check) => check.exitCode !== 0)) kinds.add("checks");
	}
	if (!kinds.size) return undefined;
	return (fixed) => [...kinds].map((kind) => REFUSED[kind](repo, change, fixed)).join("; ");
}

function printStatus(status, repo) {
	const lines = claimLines(status);
	lines.push(`head: ${status.head ? short(status.head) : "nothing pushed"}`);
	for (const vote of status.votes ?? [])
		lines.push(`  ${vote.verdict} by ${vote.reviewer} as ${vote.role}: ${firstLine(vote.evidence, 300)}`);
	if (status.head) lines.push(approvalLine(status.approval ?? {}));
	const merge = status.merge ?? {};
	if (merge.clean === false)
		lines.push(`conflicts with ${merge.into ?? "the project's branch"} in ${(merge.conflicts ?? []).join(", ")}`);
	if (merge.outsideClaim?.length) lines.push(`outside your claim: ${merge.outsideClaim.join(" ")}`);
	for (const waitsOn of status.waitsOn ?? []) lines.push(`  ${waitsOn}`);
	if (status.landed)
		lines.push(`landed as ${short(status.landed.commit)} at ${status.landed.at}: don't merge it again`);
	say(...lines);
	nextForStatus(status, repo);
}

function printHelp() {
	say(HELP);
}

/** Sets the clone up to push its change branch to the fork, with the repo and change recorded for later commands. */
function configureClone(dir, { repo, change, project, credentials }) {
	keepAccess(dir, project.url, project.token);
	const branch = `changes/${change}`;
	git(["-C", dir, "checkout", "--quiet", "-b", branch]);
	git(["-C", dir, "remote", "add", "fork", credentials.url]);
	keepAccess(dir, credentials.url, credentials.token);
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
	return branch;
}

async function startChange() {
	const [repo, change, intent, ...paths] = positional;
	if (!repo?.includes("/") || !change || !intent || !paths.length)
		throw new Usage('start <repo> <change> "<intent>" <path>...');
	const claimArgs = { repo, change, ...as("agent"), intent, paths };
	if (flags.into) claimArgs.into = flags.into;
	if (flags.from) claimArgs.from = flags.from;
	if (flags.after) claimArgs.after = flags.after.split(",");
	const claimed = await tool("claim", claimArgs);
	if (!claimed.ok) {
		say(`claim refused: ${change} overlaps claims in force`);
		for (const conflict of claimed.conflicts ?? []) {
			const intent = firstLine(conflict.intent, 80);
			say(`  ${conflict.path} overlaps ${conflict.held}: ${conflict.agent}'s ${conflict.change} (${intent})`);
		}
		follow(claimed, `narrow your paths and start again, or pick other work: githive backlog ${repo}`);
		process.exitCode = 1;
		return;
	}
	const landingOn = claimed.into ? `, landing on ${claimed.into}` : "";
	say(`claimed ${paths.join(" ")} for ${change}${landingOn}`);
	if (claimed.branch) say(claimed.branch);
	const credentials = await tool("credentials", { repo, change });
	// Start from the project's branch, since the fork may be behind. Pushes go to the fork.
	const project = credentials.project ?? { url: credentials.url, token: credentials.token, branch: "main" };
	const dir = flags.dir ?? change;
	if (existsSync(join(dir, ".git"))) {
		keepAccess(dir, project.url, project.token);
		keepAccess(dir, credentials.url, credentials.token);
		say(`${dir} exists: claim kept active, access refreshed`);
		return next(`edit only inside your claim, commit, then: cd ${dir} && githive land`);
	}
	if (existsSync(dir)) throw new Error(`${dir} exists and isn't a clone: --dir <another>`);
	// Shallow by default, since an agent needs only the tip. sync and land deepen it when needed.
	const depth = flags.full ? [] : ["--depth", "1"];
	gitWith([project], ["clone", "--quiet", ...depth, "--branch", project.branch, project.url, dir]);
	const branch = configureClone(dir, { repo, change, project, credentials });
	const head = short(git(["-C", dir, "rev-parse", "HEAD"]));
	say(`cloned ${dir}: ${project.branch} at ${head}, on ${branch}; your fork is the remote "fork"`);
	next(`edit only inside your claim (${paths.join(" ")}), commit, then: cd ${dir} && githive land`);
}

async function showStatus() {
	const { repo, change } = target(positional);
	printStatus(await tool("status", { repo, change }), repo);
}

/**
 * Pushes the clone's commits to the fork, unless it already has them. Returns false when there's nothing to land
 * yet.
 */
async function pushToFork(local, repo, change) {
	const branch = `changes/${change}`;
	if (local.branch !== branch)
		throw new Error(`you're on ${local.branch ?? "a detached HEAD"}: git checkout ${branch}, then githive land`);
	if (git(["status", "--porcelain", "--untracked-files=no"])) {
		say("uncommitted changes: they aren't part of the change until committed");
		next("git add <files> && git commit, then githive land");
		return false;
	}
	// Refresh write access every time, since a fork's token expires.
	const credentials = await tool("credentials", { repo, change });
	keepAccess(".", credentials.url, credentials.token);
	if (credentials.project) keepAccess(".", credentials.project.url, credentials.project.token);
	const mine = git(["rev-parse", "HEAD"]);
	const pushed = gitOk(["ls-remote", "fork", `refs/heads/${branch}`])?.split(/\s/)[0];
	if (pushed === mine) return true;
	// Never force-push. Pushed commits are never rewritten.
	const push = () => git(["push", "--quiet", "fork", `${branch}:refs/heads/${branch}`]);
	try {
		push();
	} catch (err) {
		if (/shallow/i.test(err.stderr ?? "") && unshallow(".")) push();
		else if (/rejected|non-fast-forward|fetch first/i.test(err.stderr ?? ""))
			throw new Error(
				`your fork's ${branch} has commits you don't: git fetch fork && git merge fork/${branch}, ` +
					"then githive land",
			);
		else throw err;
	}
	say(`pushed ${short(mine)} to your fork's ${branch}`);
	return true;
}

/** Checks the change merges cleanly and stays inside its claim. Returns false, having said why, when it doesn't. */
async function checkChange(repo, change) {
	const status = await tool("status", { repo, change });
	const checked = { head: status.head, ...status.merge };
	if (checked.error) throw new Error(checked.error);
	const onto = checked.into ?? "the project's branch";
	if (checked.clean === false) {
		say(`${short(checked.head)} conflicts with ${onto} in ${(checked.conflicts ?? []).join(", ")}`);
		follow(status, resolveConflict, { fix: checked.fix });
		process.exitCode = 1;
		return false;
	}
	if (checked.outsideClaim?.length) {
		say(`${short(checked.head)} changes files outside your claim: ${checked.outsideClaim.join(" ")}`);
		follow(status, claimThemToo(repo, change));
		process.exitCode = 1;
		return false;
	}
	say(`checked ${short(checked.head)}: merges cleanly into ${onto}, all inside your claim`);
	return true;
}

function printFailedCheck(check) {
	const tail = String(check.output ?? "")
		.trim()
		.split("\n")
		.slice(-15)
		.map((line) => `    ${line}`);
	say(`  check failed: ${check.command} (exit ${check.exitCode})`, ...tail);
}

async function landChange() {
	const { repo, change, local } = target(positional);
	if (!local) say(`not in ${change}'s clone: landing what's pushed`);
	else if (!(await pushToFork(local, repo, change))) return;
	if (!(await checkChange(repo, change))) return;
	const merged = await tool("merge", { repo, change, ...as("agent") });
	if (merged.ok) {
		const checks = merged.checks ? ` (checks ${merged.checks})` : "";
		say(`landed ${change} as ${short(merged.commit)}${checks}`);
		return follow(merged, `pick more work: githive reviews ${repo}, githive backlog ${repo}`);
	}
	if (merged.pending) {
		say(`pending: ${(merged.reasons ?? []).join(" ")}`);
		follow(merged, "githive land (it goes on waiting; nothing is lost)");
		process.exitCode = 3;
		return;
	}
	say("not landed yet:", ...(merged.reasons ?? []).map((reason) => `  ${reason}`));
	for (const check of merged.checks ?? []) if (check.exitCode !== 0) printFailedCheck(check);
	process.exitCode = 1;
	const step = refusedStep(merged, repo, change);
	// Most often it's only waiting for reviews: say where it stands and what to do meanwhile, as status does.
	const onlyApprovals = merged.why?.length && merged.why.every((kind) => kind === "approvals");
	const unexplained = !step && !merged.why?.length && !(typeof merged.next === "string" && merged.next.trim());
	if (onlyApprovals || unexplained) {
		const status = await tool("status", { repo, change }).catch(() => null);
		if (status) {
			if (status.head) say(approvalLine(status.approval ?? {}));
			return nextForStatus(status, repo);
		}
	}
	follow(merged, step, { otherwise: "githive status (what it still needs)" });
}

async function syncWithProject() {
	const local = here();
	if (!local.repo || !local.onto) throw new Usage("sync runs in a clone made by githive start");
	if (git(["status", "--porcelain", "--untracked-files=no"])) {
		say("uncommitted changes: commit them first, so the merge has a clean tree");
		return next("git add <files> && git commit, then githive sync");
	}
	// Refresh read access to the project, since the clone's token may have expired.
	const credentials = await tool("credentials", { repo: local.repo });
	keepAccess(".", credentials.url, credentials.token);
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
		say(`merging ${theirs} conflicts in:`, ...files.map((file) => `  ${file}`));
		next(`resolve them (inside your claim), git add ${files.join(" ")}, git commit --no-edit, then githive land`);
		process.exitCode = 1;
		return;
	}
	say(`merged ${theirs} (${short(git(["rev-parse", theirs]))}) into ${local.branch}`);
	next("githive land (the new commit needs approval again)");
}

async function listReviews() {
	const [repo] = positional;
	if (!repo) throw new Usage("reviews <repo>");
	const { reviews = [], more } = await tool("reviews", { repo, ...as("agent") });
	if (!reviews.length) {
		say("no reviews for you now");
		return next(`githive backlog ${repo}`);
	}
	for (const review of reviews) {
		const blocking = review.blocking ? " (can block)" : "";
		const reviewing = review.reviewing?.length ? `; reviewing: ${review.reviewing.join(", ")}` : "";
		const head = short(review.head);
		say(
			`${review.change} by ${review.author} at ${head}: ${review.needed} more ${review.role}${blocking}${reviewing}`,
			`  ${firstLine(review.intent)}  [${(review.paths ?? []).join(" ")}]`,
		);
	}
	if (more) say(`(${more} more)`);
	const first = reviews[0];
	const roleFlag = first.role !== "review" ? ` --role ${first.role}` : "";
	next(`githive review ${repo} ${first.change}${roleFlag}`);
}

async function listBacklog() {
	const [repo] = positional;
	if (!repo) throw new Usage("backlog <repo>");
	const { open = [], waiting = [], more, moreWaiting } = await tool("backlog", { repo, ...as("agent") });
	if (open.length) say("free to take:");
	for (const work of open) {
		const paths = work.paths?.length ? `  [${work.paths.join(" ")}]` : "";
		const abandoned = work.abandonedBy ? ` (abandoned by ${work.abandonedBy})` : "";
		say(`  ${work.id}: ${firstLine(work.title)}${paths}${abandoned}`);
	}
	if (more) say(`  (${more} more)`);
	if (waiting.length) say("waiting:", ...waiting.map((work) => `  ${work.id}: ${work.reason}`));
	if (moreWaiting) say(`  (${moreWaiting} more)`);
	if (!open.length) {
		say("nothing free to take now");
		return next(`githive reviews ${repo}, or githive claims ${repo} and start your own change`);
	}
	const first = open[0];
	const title = firstLine(first.title).replace(/"/g, "'");
	next(`githive start ${repo} ${first.id} "${title}" ${first.paths?.join(" ") || "<paths>"}`);
}

async function listClaims() {
	const [repo] = positional;
	if (!repo) throw new Usage("claims <repo>");
	const claims = await tool("claims", { repo });
	if (!claims.length) say("no claims in force");
	for (const claim of claims) {
		const into = claim.into ? ` -> ${claim.into}` : "";
		say(`${claim.change} (${claim.agent}): ${claim.paths.join(" ")}${into}`, `  ${firstLine(claim.intent)}`);
	}
	next(`claim paths nobody holds: githive start ${repo} <change> "<intent>" <path>..., or githive backlog ${repo}`);
}

/** Clones or refreshes the review copy and checks out the change's head, detached. */
function fetchForReview(dir, access, base) {
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
}

function diffStat(dir, base, head) {
	const sinceBase = gitOk(["-C", dir, "diff", "--stat", `${base}...${head}`]);
	if (sinceBase !== undefined) return sinceBase;
	const againstBase = git(["-C", dir, "diff", "--stat", base, head]);
	return `(no merge base in the shallow clone; against ${base} as it is now)\n${againstBase}`;
}

async function reviewChange() {
	const [repo, change] = positional;
	if (!repo?.includes("/") || !change) throw new Usage("review <repo> <change> [--role R]");
	const accessArgs = { repo, change };
	if (flags.role) accessArgs.role = flags.role;
	const access = await tool("credentials", { ...accessArgs, ...as("agent") });
	const dir = flags.dir ?? `review-${change}`;
	const base = `origin/${access.project.branch}`;
	const { head, role } = access;
	fetchForReview(dir, access, base);
	const stat = diffStat(dir, base, head);
	say(`reviewing ${change} by ${access.author} at ${short(head)} as ${role}, in ${dir}`, stat || "(no changes)");
	const roleFlag = role !== "review" ? ` --role ${role}` : "";
	next(
		`read it: git -C ${dir} diff ${base}...HEAD; then githive vote ${repo} ${head} approve|reject ` +
			`"<evidence>"${roleFlag}`,
	);
}

async function castVote() {
	const [repo, commit, verdict, evidence] = positional;
	if (!repo?.includes("/") || !commit || !["approve", "reject"].includes(verdict) || !evidence)
		throw new Usage('vote <repo> <commit> approve|reject "<evidence>" [--role R]');
	const role = flags.role ?? "review";
	const voted = await tool("vote", { repo, commit, verdict, evidence, role, ...as("reviewer") });
	say(`voted ${verdict} on ${short(commit)} as ${role}`);
	follow(voted, `githive reviews ${repo}`);
}

async function callTool() {
	const [name, json] = positional;
	if (!name) throw new Usage("call <tool> '<json args>'");
	let args;
	try {
		args = json ? JSON.parse(json) : {};
	} catch {
		throw new Usage(`call: '${json}' isn't JSON`);
	}
	say(JSON.stringify(redact(await tool(name, args)), null, 2));
}

const commands = {
	help: printHelp,
	start: startChange,
	status: showStatus,
	land: landChange,
	sync: syncWithProject,
	reviews: listReviews,
	backlog: listBacklog,
	claims: listClaims,
	review: reviewChange,
	vote: castVote,
	call: callTool,
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
