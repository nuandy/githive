import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startGitServer, type GitServer } from "./helpers/git-server";
import { toolCalls } from "./helpers/tool-calls";

// claim_work: the first free piece of the backlog among those an agent names, in its order, claimed in one call. An
// agent whose first choice another agent took moves on to its next in the same call.

let server: GitServer;
const ping = vi.fn(async () => undefined);
const { call, register } = toolCalls(() => server, { ping });

beforeEach(async () => {
	server = await startGitServer();
	ping.mockClear();
	await register("a", "b", "planner");
	await call("settings", { required: 1, vetoes: [] });
	const piece = (id: string, extra: Record<string, unknown> = {}) => ({
		id,
		title: `Build ${id}`,
		intent: `the ${id} module`,
		paths: [`src/${id}/`],
		...extra,
	});
	const items = [
		piece("one"),
		piece("two"),
		piece("app", { lands_after: ["one", "two"] }),
		piece("later", { after: ["one"] }),
	];
	await call("add_work", { agent: "planner", items }, "planner");
});
afterEach(async () => {
	await server.close();
});

describe("claim_work", () => {
	it("claims the first free piece named as claim would: its paths, intent, and what it lands after", async () => {
		const reply = await call("claim_work", { agent: "a", pieces: ["app", "one"] }, "a");
		expect(reply).toMatchObject({ ok: true, change: "app", intent: "Build app\n\nthe app module" });
		const status = await call("status", { change: "app" });
		expect(status.claim).toMatchObject({ agent: "a", paths: ["src/app/"], after: ["one", "two"] });
	});

	it("passes over pieces taken, waiting or unknown, saying why, and takes the next free one", async () => {
		await call("claim_work", { agent: "b", pieces: ["one"] }, "b");
		const reply = await call("claim_work", { agent: "a", pieces: ["one", "later", "nothing", "two"] }, "a");
		expect(reply).toMatchObject({ ok: true, change: "two" });
		expect(reply.passedOver).toEqual([
			{ piece: "one", reason: "claimed by b" },
			{ piece: "later", reason: "waits on one to merge" },
			{ piece: "nothing", reason: "not in the backlog, or merged already" },
		]);
	});

	it("gives two agents going for the same piece at once a piece each", async () => {
		const both = ["a", "b"].map((agent) => call("claim_work", { agent, pieces: ["one", "two"] }, agent));
		const replies = await Promise.all(both);
		expect(replies.map((reply) => reply.ok)).toEqual([true, true]);
		expect(new Set(replies.map((reply) => reply.change))).toEqual(new Set(["one", "two"]));
	});

	it("claims nothing when none of the pieces named is free", async () => {
		await call("claim_work", { agent: "b", pieces: ["one"] }, "b");
		const reply = await call("claim_work", { agent: "a", pieces: ["one"] }, "a");
		expect(reply).toMatchObject({ ok: false, passedOver: [{ piece: "one", reason: "claimed by b" }] });
		const claims = (await call("claims", {})) as unknown as { change: string }[];
		expect(claims.map((claim) => claim.change)).toEqual(["one"]);
	});

	it("rings and shows in the hive as the claim it made", async () => {
		await call("claim_work", { agent: "a", pieces: ["one"] }, "a");
		expect(ping).toHaveBeenCalledWith(
			"p",
			expect.objectContaining({ kind: "claimed", agent: "a", change: "one", detail: "Build one\n\nthe one module" }),
			"claim",
			{ for: [] },
		);
	});

	it("refuses a list of no pieces, or of too many", async () => {
		await expect(call("claim_work", { agent: "a", pieces: [] }, "a")).rejects.toThrow(/pieces names backlog pieces/);
		const many = Array.from({ length: 41 }, (_, i) => `p${i}`);
		await expect(call("claim_work", { agent: "a", pieces: many }, "a")).rejects.toThrow(/at most 40/);
	});
});
