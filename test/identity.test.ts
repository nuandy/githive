import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { statusOf } from "../src/errors";
import { callTool, type ToolContext } from "../src/toolkit/mcp";
import { generateStampKey, makeStamper } from "../src/toolkit/stamp";
import { startGitServer, type GitServer } from "./helpers/git-server";

// Agents that share one Access identity (one service token) still need to be
// told apart. An agent registers its name once and gets a secret key; with the
// key, what it writes is stamped as `<Access identity>/<agent>`. A registered
// name can't be used without its key, a key can't act as another name, and the
// githive- names are GitHive's own hosted agents'.

let server: GitServer;
let privateKey: string;

beforeAll(async () => {
	privateKey = (await generateStampKey()).privateKey;
});
beforeEach(async () => {
	server = await startGitServer();
});
afterEach(async () => {
	await server.close();
});

/** A caller through the shared Access identity `service:shared`, optionally with an agent key; or a hosted agent. */
const as = (agentKey?: string, hosted = false): ToolContext => ({
	remote: async () => ({ url: server.url, token: "unused" }),
	head: async () => server.git("rev-parse", "main").trim(),
	stamper: (agent?: string) =>
		makeStamper(privateKey, `service:${hosted ? "githive-builder" : "shared"}${agent ? `/${agent}` : ""}`),
	...(agentKey ? { agentKey } : {}),
	...(hosted ? { hosted } : {}),
});
const call = async (ctx: ToolContext, name: string, args: Record<string, unknown>) => {
	try {
		return await callTool(name, { repo: "project", ...args }, ctx);
	} catch (err) {
		return { error: statusOf(err).message };
	}
};
const claimA = { change: "a-1", agent: "agent-a", paths: ["src/a/"], intent: "a" };

describe("agent identity", () => {
	beforeEach(async () => {
		await call(as(), "settings", {});
	});

	it("registers a name and stamps what the agent writes with it, though agents share one Access identity", async () => {
		const a = (await call(as(), "register", { agent: "agent-a" })) as { agent: string; key: string };
		const b = (await call(as(), "register", { agent: "agent-b" })) as { agent: string; key: string };
		expect(a.agent).toBe("agent-a");
		expect(a.key).not.toBe(b.key);
		await call(as(a.key), "claim", claimA);
		await call(as(b.key), "claim", { change: "b-1", agent: "agent-b", paths: ["src/b/"], intent: "b" });
		const claims = (await call(as(), "claims", {})) as { change: string; by: string }[];
		expect(claims.map((c) => [c.change, c.by])).toEqual([
			["a-1", "service:shared/agent-a"],
			["b-1", "service:shared/agent-b"],
		]);
	});

	it("takes the key as an argument too, for agents that can't set headers", async () => {
		const { key } = (await call(as(), "register", { agent: "agent-a" })) as { key: string };
		await call(as(), "claim", { ...claimA, agent_key: key });
		expect(((await call(as(), "claims", {})) as { by: string }[])[0]!.by).toBe("service:shared/agent-a");
	});

	it("refuses a name that could break out of a record's title or a shell command", async () => {
		for (const agent of ["GitHive-Format: 99\nx", "a b", "a;b", "-a", "x".repeat(65)])
			expect(await call(as(), "register", { agent })).toMatchObject({ error: expect.stringContaining("a name is") });
		expect(await call(as(), "register", { agents: ["ok-1", "bad\nname"] })).toMatchObject({
			error: expect.stringContaining("a name is"),
		});
		expect(await call(as(), "register", { agent: "Agent_1.b" })).toMatchObject({ agent: "Agent_1.b" });
	});

	it("refuses a registered name without its key, and a key acting as another name", async () => {
		const { key } = (await call(as(), "register", { agent: "agent-a" })) as { key: string };
		expect(await call(as(), "claim", claimA)).toEqual({ error: "agent-a is registered: call with its agent key" });
		expect(await call(as(key), "claim", { ...claimA, agent: "agent-c" })).toEqual({
			error: "you act as agent-a; you can't act as agent-c",
		});
		expect(await call(as("agent-a.forged"), "claim", claimA)).toEqual({ error: "unknown agent key" });
	});

	it("never gives a registered name to anyone else; its holder can rotate the key", async () => {
		const first = (await call(as(), "register", { agent: "agent-a" })) as { key: string };
		expect(await call(as(), "register", { agent: "agent-a" })).toEqual({
			error: "agent-a is registered: call with its agent key to rotate it",
		});
		const rotated = (await call(as(first.key), "register", { agent: "agent-a" })) as { key: string };
		expect(rotated.key).not.toBe(first.key);
		expect(await call(as(first.key), "claim", claimA)).toEqual({ error: "unknown agent key" });
		expect(await call(as(rotated.key), "claim", claimA)).toMatchObject({ ok: true });
	});

	it("registers many names in one call, each with its own key, and none already registered", async () => {
		const { agents } = (await call(as(), "register", { agents: ["agent-a", "agent-b", "agent-c"] })) as {
			agents: { agent: string; key: string }[];
		};
		expect(agents.map((a) => a.agent)).toEqual(["agent-a", "agent-b", "agent-c"]);
		expect(new Set(agents.map((a) => a.key)).size).toBe(3);
		// Each key acts as its own name only.
		await call(as(agents[1]!.key), "claim", { change: "b-1", agent: "agent-b", paths: ["src/b/"], intent: "b" });
		expect(((await call(as(), "claims", {})) as { by: string }[]).map((c) => c.by)).toEqual(["service:shared/agent-b"]);
		expect(
			await call(as(agents[0]!.key), "claim", { change: "c-1", agent: "agent-c", paths: ["src/c/"], intent: "c" }),
		).toMatchObject({ error: expect.any(String) });
		// A list with a registered name in it registers none of it.
		expect(await call(as(), "register", { agents: ["agent-d", "agent-b"] })).toEqual({
			error: "already registered: agent-b (register each alone, with its agent key, to rotate it)",
		});
		expect(await call(as(), "register", { agent: "agent-d" })).toMatchObject({ agent: "agent-d" });
		expect(await call(as(), "register", { agents: ["x", "x"] })).toEqual({
			error: "agents names a name more than once",
		});
		expect(await call(as(), "register", { agents: ["githive-builder"] })).toEqual({
			error: "githive- names are GitHive's hosted agents'",
		});
	});

	it("adds many pieces of work in one call, leaving those already in the backlog as they are", async () => {
		const { key } = (await call(as(), "register", { agent: "agent-a" })) as { key: string };
		const items = [
			{ title: "Add the greeting", intent: "a greeting module", paths: ["src/greet/"] },
			{ id: "bye", title: "Add the farewell", intent: "a farewell module", paths: ["src/bye/"] },
		];
		expect(await call(as(key), "add_work", { agent: "agent-a", items })).toEqual({
			ok: true,
			added: ["add-the-greeting", "bye"],
		});
		expect(
			await call(as(key), "add_work", {
				agent: "agent-a",
				items: [...items, { id: "wave", title: "Wave", intent: "a wave" }],
			}),
		).toEqual({ ok: true, added: ["wave"], already: ["add-the-greeting", "bye"] });
		expect(await call(as(key), "add_work", { agent: "agent-a", items })).toEqual({
			ok: false,
			added: [],
			already: ["add-the-greeting", "bye"],
		});
		expect(await call(as(key), "add_work", { agent: "agent-a", items: [items[1], items[1]] })).toEqual({
			error: "each piece needs its own id: bye more than once",
		});
		expect(
			((await call(as(key), "backlog", { agent: "agent-a" })) as { open: { id: string }[] }).open
				.map((w) => w.id)
				.sort(),
		).toEqual(["add-the-greeting", "bye", "wave"]);
	});

	it("keeps githive- names for GitHive's hosted agents", async () => {
		expect(await call(as(), "register", { agent: "githive-builder" })).toEqual({
			error: "githive- names are GitHive's hosted agents'",
		});
		expect(await call(as(), "claim", { ...claimA, agent: "githive-builder" })).toEqual({
			error: "githive- names are GitHive's hosted agents'",
		});
		expect(await call(as(undefined, true), "claim", { ...claimA, agent: "githive-builder" })).toMatchObject({
			ok: true,
		});
	});

	it("lets unregistered names act as before, attributed to the Access identity alone", async () => {
		await call(as(), "claim", claimA);
		expect(((await call(as(), "claims", {})) as { by: string }[])[0]!.by).toBe("service:shared");
	});

	it("records registrations in Git, with a hash of the key, never the key", async () => {
		const { key } = (await call(as(), "register", { agent: "agent-a" })) as { key: string };
		const registry = server.git("log", "-p", "refs/notes/githive-claims/project");
		expect(registry).toContain("agent-a");
		expect(registry).not.toContain(key.split(".").pop());
	});
});

describe("signed-in agents", () => {
	/** An agent signed in to GitHive: its token names it <handle>/<agent>, under its owner's person:<hash>. */
	const signedIn = (agent: string): ToolContext => ({
		remote: async () => ({ url: server.url, token: "unused" }),
		head: async () => server.git("rev-parse", "main").trim(),
		stamper: (acting?: string) => makeStamper(privateKey, `person:ada000000000${acting ? `/${acting}` : ""}`),
		agent,
	});

	beforeEach(async () => {
		await call(as(), "settings", {});
	});

	it("act as their verified name with no key or agent argument, and are stamped under their owner", async () => {
		expect(
			await call(signedIn("ada/builder"), "claim", { change: "a-1", paths: ["src/a/"], intent: "a" }),
		).toMatchObject({ ok: true });
		const claims = (await call(as(), "claims", {})) as { change: string; agent: string; by: string }[];
		expect(claims.map((c) => [c.change, c.agent, c.by])).toEqual([
			["a-1", "ada/builder", "person:ada000000000/ada/builder"],
		]);
	});

	it("can't act as another name, and nobody else can act as theirs", async () => {
		expect(await call(signedIn("ada/builder"), "claim", { ...claimA, agent: "agent-a" })).toEqual({
			error: "you act as ada/builder; you can't act as agent-a",
		});
		expect(await call(as(), "claim", { ...claimA, agent: "ada/builder" })).toEqual({
			error: "ada/builder is a signed-in agent's name: sign in to GitHive as it to act as it",
		});
	});

	it("need no register, and nobody registers a name with a slash", async () => {
		expect(await call(signedIn("ada/builder"), "register", { agent: "x" })).toEqual({
			error: "you're signed in as ada/builder: what you write is already attributed to you, with no key",
		});
		expect(await call(as(), "register", { agent: "ada/builder" })).toEqual({
			error: 'names with "/" are signed-in agents\' (<handle>/<agent>); register a name without one',
		});
	});
});

describe("GitHive's hosted agents", () => {
	/** A signed-in agent whose owner is, or isn't, on the admin's list. */
	const listed = (allowed: boolean): ToolContext => ({
		remote: async () => ({ url: server.url, token: "unused" }),
		head: async () => server.git("rev-parse", "main").trim(),
		agent: "ada/builder",
		mayUseHosted: async () => allowed,
		startBuilder: async (input) => ({ change: input.change, builder: "b" }),
		requestReview: async () => ({ head: "h1", reviewers: ["review"] }),
	});

	it("are only for the people an admin lists: build and request_review refuse anyone else", async () => {
		const refusal = "GitHive's hosted agents are by invitation: ask an admin to add you";
		expect(await call(listed(false), "build", { intent: "Add stats", paths: ["src/stats/"] })).toEqual({
			error: refusal,
		});
		expect(await call(listed(false), "request_review", { change: "a-1" })).toEqual({ error: refusal });
		// On the list, they get past the gate; here request_review then finds no claim.
		expect(await call(listed(true), "request_review", { change: "a-1" })).toEqual({
			error: "a-1 holds no claim: claim the change's paths first",
		});
	});

	it("say, when they won't review a change, who else can: another agent, its own, or a person", async () => {
		const nextOf = (ctx: ToolContext, args: Record<string, unknown>) =>
			callTool("request_review", { repo: "project", ...args }, ctx).then(
				() => undefined,
				(err) => statusOf(err).next,
			);
		expect(await nextOf(listed(false), { change: "a-1" })).toMatch(
			/review it yourself in a fresh context; or ask a person: `ask_human` with change a-1 and why puts it in/,
		);
		// Where no hosted reviewer can run at all, the same.
		const none = { ...listed(true), requestReview: undefined };
		await call(listed(true), "claim", { ...claimA, agent: "ada/builder" });
		expect(await nextOf(none, { change: "a-1" })).toMatch(/^wait for another agent's review/);
	});
});
