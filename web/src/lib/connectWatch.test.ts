import { describe, expect, it } from "vitest";
import type { Connection } from "../api";
import { WATCH_EVERY_MS, WATCH_FOR_MS, watchStep } from "./connectWatch";

// After someone copies the command that connects an agent, the Agents page looks for the new connection every few
// seconds for a while, and says so once it's there.

const connection = (id: string, agent = "robin/builder"): Connection => ({
	id,
	client: "Claude Code",
	agentId: `a-${id}`,
	agent,
	createdAt: "2026-10-13T12:00:00.000Z",
});

describe("watching for a new connection", () => {
	it("looks every 3 seconds, for 2 minutes", () => {
		expect(WATCH_EVERY_MS).toBe(3_000);
		expect(WATCH_FOR_MS).toBe(120_000);
	});

	it("finds a connection that wasn't there when it began, and stops", () => {
		const before = new Set(["g1"]);
		const step = watchStep({ startedAt: 0, before }, 6_000, [connection("g1"), connection("g2", "robin/scout")]);
		expect(step).toEqual({ kind: "found", connection: connection("g2", "robin/scout") });
	});

	it("keeps looking while only the old ones are there", () => {
		const before = new Set(["g1"]);
		expect(watchStep({ startedAt: 0, before }, 3_000, [connection("g1")])).toEqual({ kind: "waiting" });
		expect(watchStep({ startedAt: 0, before }, 119_999, [])).toEqual({ kind: "waiting" });
	});

	it("gives up after 2 minutes with nothing new, but takes one that came at the last look", () => {
		const before = new Set(["g1"]);
		expect(watchStep({ startedAt: 1_000, before }, 121_000, [connection("g1")])).toEqual({ kind: "gave-up" });
		expect(watchStep({ startedAt: 1_000, before }, 121_000, [connection("g2")])).toMatchObject({ kind: "found" });
	});
});
