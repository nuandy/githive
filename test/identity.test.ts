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
	stamper: (agent?: string) => makeStamper(privateKey, `service:${hosted ? "githive-builder" : "shared"}${agent ? `/${agent}` : ""}`),
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
		await call(as(), "start", {});
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
		expect(((await call(as(), "claims", {})) as { by: string }[])[0].by).toBe("service:shared/agent-a");
	});

	it("refuses a registered name without its key, and a key acting as another name", async () => {
		const { key } = (await call(as(), "register", { agent: "agent-a" })) as { key: string };
		expect(await call(as(), "claim", claimA)).toEqual({ error: "agent-a is registered: call with its agent key" });
		expect(await call(as(key), "claim", { ...claimA, agent: "agent-c" })).toEqual({ error: "your agent key is agent-a's; it can't act as agent-c" });
		expect(await call(as("agent-a.forged"), "claim", claimA)).toEqual({ error: "unknown agent key" });
	});

	it("never gives a registered name to anyone else; its holder can rotate the key", async () => {
		const first = (await call(as(), "register", { agent: "agent-a" })) as { key: string };
		expect(await call(as(), "register", { agent: "agent-a" })).toEqual({ error: "agent-a is registered: call with its agent key to rotate it" });
		const rotated = (await call(as(first.key), "register", { agent: "agent-a" })) as { key: string };
		expect(rotated.key).not.toBe(first.key);
		expect(await call(as(first.key), "claim", claimA)).toEqual({ error: "unknown agent key" });
		expect(await call(as(rotated.key), "claim", claimA)).toMatchObject({ ok: true });
	});

	it("keeps githive- names for GitHive's hosted agents", async () => {
		expect(await call(as(), "register", { agent: "githive-builder" })).toEqual({ error: "githive- names are GitHive's hosted agents'" });
		expect(await call(as(), "claim", { ...claimA, agent: "githive-builder" })).toEqual({ error: "githive- names are GitHive's hosted agents'" });
		expect(await call(as(undefined, true), "claim", { ...claimA, agent: "githive-builder" })).toMatchObject({ ok: true });
	});

	it("lets unregistered names act as before, attributed to the Access identity alone", async () => {
		await call(as(), "claim", claimA);
		expect(((await call(as(), "claims", {})) as { by: string }[])[0].by).toBe("service:shared");
	});

	it("records registrations in Git, with a hash of the key, never the key", async () => {
		const { key } = (await call(as(), "register", { agent: "agent-a" })) as { key: string };
		const registry = server.git("log", "-p", "refs/notes/githive-claims/project");
		expect(registry).toContain("agent-a");
		expect(registry).not.toContain(key.split(".").pop());
	});
});
