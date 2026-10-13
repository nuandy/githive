import { describe, expect, it } from "vitest";
import type { Connection, MyAgent } from "../api";
import { NOW, ago } from "../test/fixtures";
import { agentState, calendarDate, connectionsOf, expiryWords, otherConnections, whenWords } from "./myAgents";

// The words on Your agents: when each agent was last seen, how it connects, and every date in one form.

const DAY = 24 * 60;
const token = (lastUsedAt: string | null, more: Partial<MyAgent["tokens"][number]> = {}) => ({
	id: `t-${lastUsedAt}`,
	agentId: "a1",
	prefix: "Ab3dEf9h",
	createdAt: ago(DAY * 3),
	expiresAt: null,
	lastUsedAt,
	revokedAt: null,
	...more,
});
const agent = (more: Partial<MyAgent> = {}): MyAgent => ({
	id: "a1",
	ownerId: "u1",
	name: "builder",
	createdAt: ago(DAY * 2),
	revokedAt: null,
	tokens: [],
	...more,
});
const connection = (more: Partial<Connection> = {}): Connection => ({
	id: "g1",
	client: "Claude Code",
	agentId: "a1",
	agent: "robin/builder",
	createdAt: ago(DAY * 12),
	...more,
});

describe("dates on Your agents", () => {
	it("are relative for the last 30 days, then a calendar date, in one form", () => {
		expect(whenWords(ago(9), NOW)).toBe("9 minutes ago");
		expect(whenWords(ago(DAY * 3), NOW)).toBe("3 days ago");
		const old = ago(DAY * 58);
		expect(whenWords(old, NOW)).toBe(`on ${calendarDate(old)}`);
		expect(calendarDate("2026-08-16T12:00:00.000Z")).toBe(
			new Date("2026-08-16T12:00:00.000Z").toLocaleDateString(undefined, {
				year: "numeric",
				month: "short",
				day: "numeric",
			}),
		);
	});

	it("say when a token stops working, or that it doesn't", () => {
		const later = new Date(NOW + 40 * 86_400_000).toISOString();
		expect(expiryWords(later, NOW)).toBe(`expires ${calendarDate(later)}`);
		const before = ago(DAY * 5);
		expect(expiryWords(before, NOW)).toBe(`expired ${calendarDate(before)}`);
		expect(expiryWords(null, NOW)).toBe("never expires");
	});
});

describe("an agent's state", () => {
	it("is when it was last active, from its tokens, when it has no app signed in", () => {
		expect(agentState(agent({ tokens: [token(ago(60)), token(ago(9))] }), [], NOW)).toBe("Last active 9 minutes ago");
	});

	it("is when its app connected, when it signs in from one: GitHive doesn't record each use of a sign-in", () => {
		expect(agentState(agent(), [connection()], NOW)).toBe("Connected 12 days ago");
		expect(agentState(agent({ tokens: [token(ago(9))] }), [connection()], NOW)).toBe(
			"Connected 12 days ago · a token used 9 minutes ago",
		);
	});

	it("says it isn't connected yet, with no app and no token used", () => {
		expect(agentState(agent({ tokens: [token(null)] }), [], NOW)).toBe("Not connected yet");
	});
});

describe("connected apps", () => {
	it("go in their agent's card; one tied to no agent of yours stays listed on its own", () => {
		const mine = connection();
		const loose = connection({ id: "g2", agentId: null, agent: null, client: "Zed" });
		const gone = connection({ id: "g3", agentId: "a9", agent: "robin/old" });
		expect(connectionsOf("a1", [mine, loose, gone])).toEqual([mine]);
		expect(otherConnections([agent()], [mine, loose, gone])).toEqual([loose, gone]);
	});
});
