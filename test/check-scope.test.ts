import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { skipsChecks, skipsFile } from "../src/toolkit/check-scope";
import { pushChange } from "./helpers/agents";
import { startGitServer, type GitServer } from "./helpers/git-server";
import { toolCalls } from "./helpers/tool-calls";

// A change that only touches documentation and other files no check reads
// merges without running the checks; anything else runs them, and so does a
// file under a folder tests read.

describe("what the checks skip", () => {
	it("is Markdown, docs folders, licenses and images by default, anywhere but where tests read", () => {
		expect(skipsChecks(["README.md", "docs/guide/setup.html", "LICENSE", "img/logo.png"])).toBe(true);
		expect(skipsChecks(["README.md", "lib/index.js"])).toBe(false);
		expect(skipsChecks(["examples/markdown/views/index.md"])).toBe(false);
		expect(skipsChecks(["test/fixtures/data.md"])).toBe(false);
		expect(skipsChecks(["requirements.txt"])).toBe(false);
		expect(skipsChecks([])).toBe(false);
	});

	it("follows a repo's own patterns, and never skips with none", () => {
		expect(skipsFile("docs/", "packages/a/docs/x.js")).toBe(true);
		expect(skipsFile("site/*.html", "site/index.html")).toBe(true);
		expect(skipsFile("site/*.html", "site/a/index.html")).toBe(false);
		expect(skipsChecks(["CHANGELOG"], ["CHANGELOG"])).toBe(true);
		expect(skipsChecks(["README.md"], [])).toBe(false);
	});
});

let server: GitServer;
let work: string;
const { call, register, approve } = toolCalls(() => server);
// There is no check runner here, so a merge that needs its checks is refused and
// one that skips them merges.
async function approved(change: string, files: Record<string, string>) {
	await call("claim", { change, agent: "a", paths: Object.keys(files), intent: change }, "a");
	const head = await pushChange(server.url, work, "a", change, files);
	await approve(head);
}

beforeEach(async () => {
	server = await startGitServer();
	work = mkdtempSync(join(tmpdir(), "githive-check-scope-"));
	await call("settings", { required: 1, vetoes: [], verify: ["npm test"] });
	await register("a", "reviewer");
});
afterEach(async () => {
	await server.close();
	rmSync(work, { recursive: true, force: true });
});

describe("a merge", () => {
	it("skips the checks for a documentation change, says so, and the audit finds nothing wrong", async () => {
		await approved("docs", { "docs/guide.md": "how\n", "README.md": "more\n" });
		expect(await call("merge", { change: "docs", agent: "a" }, "a")).toMatchObject({
			ok: true,
			checks: expect.stringContaining("skipped"),
		});
		expect(await call("audit", {})).toMatchObject({ merges: 1, open: 0 });
	});

	it("runs them for code, and for Markdown where tests read it", async () => {
		await approved("code", { "lib/x.js": "x\n" });
		await expect(call("merge", { change: "code", agent: "a" }, "a")).rejects.toThrow(
			/checks are configured but nothing can run them/,
		);
		await approved("example", { "examples/markdown/views/index.md": "# changed\n" });
		await expect(call("merge", { change: "example", agent: "a" }, "a")).rejects.toThrow(
			/checks are configured but nothing can run them/,
		);
	});

	it("runs them for everything once the repo says to skip nothing", async () => {
		expect(await call("settings", { skip_checks: [] })).toMatchObject({ skipChecks: [] });
		await approved("docs", { "docs/guide.md": "how\n" });
		await expect(call("merge", { change: "docs", agent: "a" }, "a")).rejects.toThrow(
			/checks are configured but nothing can run them/,
		);
	});
});
