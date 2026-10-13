#!/usr/bin/env node
// Puts Clef's hints through GitHive's real tools on a Worker: in a scratch repo it makes, agents claim, add backlog
// pieces, vote and ask people things, each meant to draw one answer from Clef (a duplicate, vague or thin evidence,
// a piece too big, an urgency, or none). Prints each reply's part that Clef shapes, with the call's time, then deletes the
// repo.
//
//   node scripts/clef-probe.mjs [--base URL] [--owner nuandy]
//
// Credentials come from .dev.vars (CF_ACCESS_CLIENT_ID, CF_ACCESS_CLIENT_SECRET) and are never printed.

import { BENCH_BASE, githiveClient, parseFlags } from "./lib/bench-client.mjs";

const flags = parseFlags();
const client = githiveClient(flags.base ?? BENCH_BASE);
const owner = flags.owner ?? "nuandy";
const name = `clef-probe-${Date.now().toString(36)}`;
const repo = `${owner}/${name}`;
const keys = {};

/** Calls a tool as `agent`, and returns its reply, whether it was refused, and how long it took. */
async function call(tool, args, agent) {
	const started = Date.now();
	const { text, isError } = await client.toolReply(tool, { repo, ...args }, agent && keys[agent]);
	let reply = text;
	try {
		reply = JSON.parse(text);
	} catch {
		// A refusal is plain text.
	}
	return { ms: Date.now() - started, refused: isError, reply };
}

function show(label, outcome, fields) {
	const shown = outcome.refused
		? outcome.reply
		: Object.fromEntries(fields.flatMap((field) => (field in outcome.reply ? [[field, outcome.reply[field]]] : [])));
	console.log(`${label} [${outcome.ms} ms]${outcome.refused ? " REFUSED" : ""}: ${JSON.stringify(shown)}`);
}

const claim = (agent, change, intent, paths) => call("claim", { change, agent, intent, paths }, agent);

async function duplicates() {
	show("claim", await claim("alice", "rate-limit", "Rate-limit login attempts per IP", ["src/auth/"]), ["ok"]);
	const throttle = "Throttle repeated failed logins so brute force stops";
	show("same work, other paths", await claim("bob", "throttle", throttle, ["src/limits/"]), ["ok", "similar", "next"]);
	const darkMode = "Add a dark mode toggle to settings";
	show("different work", await claim("bob", "dark-mode", darkMode, ["src/theme/"]), ["ok", "similar"]);
	const items = [
		{ id: "lockout", title: "Lock accounts after 5 failed logins", intent: "Lock an account for 15 minutes" },
		{ id: "csv-export", title: "Export reports as CSV", intent: "A button that downloads the report table" },
	];
	show("backlog pieces", await call("add_work", { agent: "alice", items }, "alice"), ["ok", "added", "similar"]);
	const rewrite = "Rewrite the whole app in another framework, with new sign-in, billing and an admin console";
	const big = { agent: "alice", id: "rewrite", title: "Rewrite the app", intent: rewrite };
	show("a piece too big for one change", await call("add_work", big, "alice"), ["ok", "tooBig"]);
}

async function evidence() {
	const commit = "0123456789abcdef0123456789abcdef01234567";
	const reject = (text) =>
		call(
			"vote",
			{ commit, change: "rate-limit", reviewer: "rev", role: "review", verdict: "reject", evidence: text },
			"rev",
		);
	show("vague rejection", await reject("not good, redo it"), ["ok", "vagueEvidence", "next"]);
	const specific =
		"src/auth/limit.ts:42 counts attempts per user, not per IP, so one IP can try every account; key it by IP";
	show("specific rejection", await reject(specific), ["ok", "vagueEvidence"]);
	const approve = (text) =>
		call(
			"vote",
			{ commit, change: "rate-limit", reviewer: "rev", role: "review", verdict: "approve", evidence: text },
			"rev",
		);
	show("thin approval", await approve("LGTM"), ["ok", "thinEvidence", "next"]);
	const checked =
		"Ran npm test (42 pass); read src/auth/limit.ts and tried 6 bad logins from one IP: the 6th is refused";
	show("checked approval", await approve(checked), ["ok", "thinEvidence"]);
}

const QUESTIONS = {
	"revert-q": "Production logins are failing for every user since this landed: should I revert now?",
	"build-q": "The build is broken on main and blocks all twelve agents: may I force a fix?",
	"copy-q": "Should the footer say 2026 or the current year? Either is fine.",
};

async function questions() {
	for (const [change, reason] of Object.entries(QUESTIONS)) {
		await claim("carol", change, `Work on ${change}`, [`src/${change}/`]);
		show(`question ${change}`, await call("ask_human", { change, agent: "carol", reason }, "carol"), ["ok"]);
	}
	// The repo's snapshot is kept for a short while, so wait for one with the questions in it.
	for (let tries = 0; tries < 12; tries++) {
		const snapshot = await client.api("GET", `/repos/${repo}`);
		const asked = snapshot.claims.filter((claim) => claim.change in QUESTIONS && claim.attention);
		if (asked.length === Object.keys(QUESTIONS).length) {
			for (const claim of asked) console.log(`urgency ${claim.change}: ${claim.attention.urgency ?? "none"}`);
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, 5_000));
	}
	console.log("urgency: the snapshot never showed every question");
}

await client.api("POST", "/repos", { owner, name, init: { readme: true } });
console.log(`repo ${repo}, ${new Date().toISOString()}`);
try {
	await call("settings", { required: 1 });
	for (const agent of ["alice", "bob", "rev", "carol"])
		keys[agent] = JSON.parse((await client.toolReply("register", { repo, agent })).text).key;
	await duplicates();
	await evidence();
	await questions();
} finally {
	await client.api("DELETE", `/repos/${repo}`);
	console.log(`deleted ${repo}`);
}
