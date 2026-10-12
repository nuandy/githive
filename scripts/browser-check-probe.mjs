#!/usr/bin/env node
// Puts the browser check through a real check container: in a scratch repo whose only check is
// githive-browser-check, an agent pushes a page with a dead button (two handlers that undo each other) and asks to
// merge, which should be sent back with the check's output; then it pushes the fix, which should land. Prints each
// step with its time, then deletes the repo.
//
//   node scripts/browser-check-probe.mjs [--base URL] [--owner nuandy]
//
// Credentials come from .dev.vars (CF_ACCESS_CLIENT_ID, CF_ACCESS_CLIENT_SECRET) and are never printed.

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BENCH_BASE, ROOT, githiveClient, parseFlags } from "./lib/bench-client.mjs";

const flags = parseFlags();
const base = flags.base ?? BENCH_BASE;
const client = githiveClient(base);
const owner = flags.owner ?? "nuandy";
const name = `browser-probe-${Date.now().toString(36)}`;
const repo = `${owner}/${name}`;
const work = mkdtempSync(join(tmpdir(), "browser-probe-"));
const keyFile = join(work, "agent.key");
const clone = join(work, "page");
const started = Date.now();
const log = (line) => console.log(`[${((Date.now() - started) / 1000).toFixed(0)} s] ${line}`);

const page = (handlers) => `<!doctype html>
<html><body>
<button id="show">Show</button>
<div id="panel" hidden>Panel</div>
<script>
const panel = document.getElementById("panel");
const show = document.getElementById("show");
${handlers}
</script>
</body></html>
`;
// Two modules each toggling the panel: right alone, wrong together, so the button does nothing.
const DEAD = page(
	'show.addEventListener("click", () => panel.toggleAttribute("hidden"));\n' +
		'show.addEventListener("click", () => panel.toggleAttribute("hidden"));',
);
const FIXED = page('show.addEventListener("click", () => panel.toggleAttribute("hidden"));');

const agent = (...args) =>
	execFileSync("node", [join(ROOT, "scripts/mcp-agent.mjs"), ...args, "--base", base], { encoding: "utf8" });
const git = (...args) => execFileSync("git", ["-C", clone, ...args], { encoding: "utf8" });

async function call(tool, args) {
	const { text } = await client.toolReply(tool, { repo, ...args }, readKey());
	try {
		return JSON.parse(text);
	} catch {
		return text;
	}
}

let key;
function readKey() {
	key ??= execFileSync("cat", [keyFile], { encoding: "utf8" }).trim();
	return key;
}

/** Asks to merge until GitHive answers with an outcome rather than "pending", as an agent would. */
async function mergeUntilDone() {
	for (;;) {
		const outcome = await call("merge", { change: "page", agent: "builder" });
		if (outcome?.pending !== true) return outcome;
		await new Promise((done) => setTimeout(done, 10_000));
	}
}

function pushPage(html, message) {
	writeFileSync(join(clone, "index.html"), html);
	git("add", "index.html");
	git("commit", "-q", "-m", message);
	git("push", "-q", "fork", "HEAD:changes/page");
}

await client.api("POST", "/repos", { owner, name, init: { readme: true } });
log(`repo ${repo}`);
try {
	agent("register", repo, "builder", keyFile);
	await call("settings", { required: 0, verify: ["githive-browser-check"] });
	const claimed = await call("claim", { change: "page", agent: "builder", paths: ["index.html"], intent: "A page" });
	log(`claimed: ${claimed.ok}`);
	agent("clone", clone, "--repo", repo, "--change", "page", "--key-file", keyFile, "--as", "builder");
	pushPage(DEAD, "page: a Show button");
	log("pushed the page with the dead button; merging");
	const refused = await mergeUntilDone();
	log(`merge: ${JSON.stringify(refused).slice(0, 1_500)}`);
	pushPage(FIXED, "page: one handler toggles the panel");
	log("pushed the fix; merging");
	const landed = await mergeUntilDone();
	log(`merge: ${JSON.stringify(landed).slice(0, 600)}`);
} finally {
	await client.api("DELETE", `/repos/${repo}`);
	rmSync(work, { recursive: true, force: true });
	log(`deleted ${repo}`);
}
