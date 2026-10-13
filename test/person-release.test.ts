import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GitCasLog } from "../src/record-log";
import type { Registry } from "../src/toolkit/claims";
import { releaseAsPerson, type ToolContext } from "../src/toolkit/mcp";
import { generateStampKey, makeStamper } from "../src/toolkit/stamp";
import { RELEASED_NOTE } from "../src/toolkit/tools/dashboard";
import { pushChange } from "./helpers/agents";
import { startGitServer, type GitServer } from "./helpers/git-server";
import { toolCalls } from "./helpers/tool-calls";

// A person who can write frees a stuck change from the dashboard, whoever's it is: its claim released with their
// reason, its paths free, its agent told, its commits left on its branch, and the audit content with it.

let server: GitServer;
let work: string;
let privateKey: string;
beforeEach(async () => {
	server = await startGitServer();
	work = mkdtempSync(join(tmpdir(), "githive-person-release-"));
	({ privateKey } = await generateStampKey());
});
afterEach(async () => {
	await server.close();
	rmSync(work, { recursive: true, force: true });
});

const { ctx, call, register } = toolCalls(() => server, {
	stamper: async (agent) => makeStamper(privateKey, agent ? `service:test/${agent}` : "service:test"),
});
const person = "person:ana@example.com";
const registryNow = async () =>
	(await new GitCasLog<Registry>(
		async () => ({ url: server.url, token: "unused" }),
		"p",
		"refs/notes/githive-claims/p",
	).read())!.commit.state;

/** The dashboard's context for the person, stamped as them, keeping what its agents are told. */
function asPerson(told: unknown[] = []): ToolContext {
	return {
		...ctx(),
		stamper: async () => makeStamper(privateKey, person),
		notify: async (_repo, branch, notices) => void told.push({ branch, notices }),
	};
}

describe("a person releasing a change", { timeout: 120_000 }, () => {
	it("frees its paths, tells its agent and keeps its commits, and the audit accepts it", async () => {
		await call("settings", { required: 1 });
		await register("a", "b");
		await call("claim", { change: "c-1", agent: "a", paths: ["src/a/"], intent: "Work on a" }, "a");
		const head = await pushChange(server.url, work, "a", "c-1", { "src/a/x.js": "x\n" });
		const claimB = { change: "c-2", agent: "b", paths: ["src/a/x.js"], intent: "Work on x" };
		expect(await call("claim", claimB, "b")).toMatchObject({ ok: false });

		const told: unknown[] = [];
		const why = "  It needs package.json, which is outside its claim.  ";
		expect(await releaseAsPerson(asPerson(told), "p", "c-1", person, why)).toEqual({
			ok: true,
			released: "c-1",
			note: RELEASED_NOTE,
		});
		const registry = await registryNow();
		expect(registry.claims).toEqual([]);
		const released = registry.released.at(-1)!;
		expect(released).toMatchObject({
			change: "c-1",
			agent: "a",
			by: person,
			verifiedBy: person,
			reason: "It needs package.json, which is outside its claim.",
		});
		expect(released.stale).toBeUndefined();
		expect(told).toEqual([
			{
				branch: "main",
				notices: [
					{
						agent: "a",
						notice: expect.objectContaining({
							kind: "released",
							change: "c-1",
							says: "A person released your claim on c-1: It needs package.json, which is outside its claim.",
						}),
					},
				],
			},
		]);
		// Its commits stay on its branch; its paths are another agent's to claim.
		expect(server.git("rev-parse", "changes/c-1").trim()).toBe(head);
		expect(await call("claim", claimB, "b")).toMatchObject({ ok: true });
		expect(await call("audit", {})).toMatchObject({ open: 0 });
	});

	it("needs a person, a reason and a claim", async () => {
		await call("settings", { required: 1 });
		await register("a");
		await call("claim", { change: "c-1", agent: "a", paths: ["src/a/"], intent: "Work on a" }, "a");
		await expect(releaseAsPerson(asPerson(), "p", "c-1", person, "  ")).rejects.toThrow(/\[400\] say why/);
		await expect(releaseAsPerson(asPerson(), "p", "c-1", "service:test/a", "stuck")).rejects.toThrow(/\[403\]/);
		await expect(releaseAsPerson(asPerson(), "p", "c-1", `${person}/agent`, "stuck")).rejects.toThrow(/\[403\]/);
		await expect(releaseAsPerson(asPerson(), "p", "nope", person, "stuck")).rejects.toThrow(
			/\[409\] nope holds no claim/,
		);
		expect((await registryNow()).claims.map((claim) => claim.change)).toEqual(["c-1"]);
	});

	it("still counts an agent's release of another's active claim against the audit", async () => {
		await call("settings", { required: 1 });
		await register("a", "b");
		await call("claim", { change: "c-1", agent: "a", paths: ["src/a/"], intent: "Work on a" }, "a");
		// An agent can't do it through release; nor does a person's release made under an agent's stamp pass.
		await expect(call("release", { change: "c-1", agent: "b" }, "b")).rejects.toThrow(/only its agent releases it/);
		const asAgent = { ...asPerson(), stamper: async () => makeStamper(privateKey, "service:test/b") };
		await releaseAsPerson(asAgent, "p", "c-1", person, "stuck");
		expect(await call("audit", {})).toMatchObject({ open: 1 });
	});
});
