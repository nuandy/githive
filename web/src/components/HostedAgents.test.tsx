import { describe, expect, it } from "vitest";
import type { HiveStatus } from "../api";
import { agentWords, hiveWords } from "./HostedAgents";

const NOW = Date.parse("2026-10-12T16:00:00.000Z");
const agent = { name: "githive-scout", finished: [], reviewed: 0, done: false };
const hive = (fields: Partial<HiveStatus>): HiveStatus => ({
	names: ["githive-forager", "githive-scout"],
	startedAt: NOW - 10 * 60_000,
	until: NOW + 20 * 60_000,
	by: "ada",
	agents: [],
	working: true,
	...fields,
});

describe("hosted agents on the Agents tab", () => {
	it("say what each agent is on", () => {
		expect(agentWords({ ...agent, change: "add-scoring" })).toBe("building add-scoring");
		expect(agentWords({ ...agent, reviewing: { change: "add-board" } })).toBe("reviewing add-board");
		expect(agentWords(agent)).toBe("looking for work");
		expect(agentWords({ ...agent, change: "add-scoring", done: true })).toBe("stopped");
	});

	it("say how long they take work, and when they're finishing or stopped", () => {
		expect(hiveWords(hive({}), NOW)).toMatch(/^2 agents started by ada .*, taking work for 20 more minutes\.$/);
		expect(hiveWords(hive({ until: NOW - 1 }), NOW)).toMatch(/finishing what they started\.$/);
		expect(hiveWords(hive({ working: false }), NOW)).toMatch(/all stopped now\.$/);
	});
});
