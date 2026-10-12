import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolContext } from "../src/toolkit/mcp";
import { pushChange } from "./helpers/agents";
import { startGitServer, type GitServer } from "./helpers/git-server";
import { toolCalls } from "./helpers/tool-calls";

// A merge commit's story lists its change's earlier attempts to land (conflicts, failed checks), as RepoCache kept
// them. They're asked for once per batch as it lands, and they're only the story: a call that fails or hangs lands
// the batch without them.

let server: GitServer;
let work: string;

beforeEach(async () => {
	server = await startGitServer();
	work = mkdtempSync(join(tmpdir(), "githive-merge-story-"));
});
afterEach(async () => {
	await server.close();
	rmSync(work, { recursive: true, force: true });
});

const conflict = 'conflict on src/a/total.js with c-7 by alice ("add partial refunds", 6584265)';

/** Agents a and b on repo p, with no reviews or checks, each with a change claimed and pushed. */
async function pushedChanges(extra: Partial<ToolContext>) {
	const tools = toolCalls(() => server, extra);
	await tools.call("settings", {});
	await tools.register("a", "b");
	await tools.call("claim", { change: "c-a", agent: "a", paths: ["src/a/"], intent: "Round invoice totals" }, "a");
	await tools.call("claim", { change: "c-b", agent: "b", paths: ["src/b/"], intent: "Show totals" }, "b");
	await pushChange(server.url, work, "a", "c-a", { "src/a/total.js": "round\n" });
	await pushChange(server.url, work, "b", "c-b", { "src/b/show.js": "show\n" });
	const merge = async () => {
		const merged = (await tools.call("merge", { change: "c-a", agent: "a" }, "a")) as { ok: boolean; commit: string };
		expect(merged).toMatchObject({ ok: true });
		return merged.commit;
	};
	return { ...tools, merge };
}

describe("a merge commit's earlier attempts", { timeout: 60_000 }, () => {
	it("are filled from the attempts noted, asked once for the batch", async () => {
		const attemptsOf = vi.fn(async (_repo: string, changes: string[]) =>
			Object.fromEntries(changes.filter((change) => change === "c-a").map((change) => [change, [conflict]])),
		);
		const { merge } = await pushedChanges({ attemptsOf });
		await merge();
		// Both changes landed in one batch, each as its own merge commit.
		const messages = server
			.git("log", "--first-parent", "-2", "--format=%B%x1e", "main")
			.split("\x1e")
			.map((message) => message.trim())
			.filter(Boolean);
		const ofChange = (change: string) => messages.find((message) => message.includes(`GitHive-Change: ${change}\n`))!;
		expect(ofChange("c-a")).toContain(`Merge c-a by a.\n\nEarlier attempts:\n- ${conflict}\n\nGitHive-Change: c-a\n`);
		expect(ofChange("c-b")).not.toContain("Earlier attempts:");
		expect(attemptsOf).toHaveBeenCalledTimes(1);
		expect(attemptsOf.mock.calls[0]![0]).toBe("p");
		expect([...attemptsOf.mock.calls[0]![1]].sort()).toEqual(["c-a", "c-b"]);
	});

	it("are left out when asking for them fails, and the batch still lands", async () => {
		const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
		try {
			const failing = await pushedChanges({ attemptsOf: async () => Promise.reject(new Error("RepoCache down")) });
			expect(server.git("log", "-1", "--format=%B", await failing.merge())).not.toContain("Earlier attempts:");
			expect(errors.mock.calls.map((args) => String(args[0]))).toContain(
				"reading earlier attempts failed: landing without them",
			);
		} finally {
			errors.mockRestore();
		}
	});

	it("are left out when asking for them hangs, and the batch lands within seconds", async () => {
		const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
		try {
			const hanging = await pushedChanges({ attemptsOf: () => new Promise(() => undefined) });
			const startedAt = Date.now();
			expect(server.git("log", "-1", "--format=%B", await hanging.merge())).not.toContain("Earlier attempts:");
			expect(Date.now() - startedAt).toBeLessThan(15_000);
			expect(errors.mock.calls.map((args) => String(args[0]))).toContain(
				"reading earlier attempts took over 2000 ms: landing without them",
			);
		} finally {
			errors.mockRestore();
		}
	});
});
