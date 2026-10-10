import { describe, expect, it } from "vitest";
import { EVENTS_KEPT, type HiveEvent, pushEvents, settledEvents, toolEvent, withEvents } from "../src/hive-events";
import { FakeStorage } from "./fakes/env";

const { RepoCache } = await import("../src/repo-cache");

// The hive's live feed: what each agent did, from its tool calls, its pushes and its landings, kept as a short log.

const NOW = new Date("2026-10-11T12:00:00.000Z");
const HEAD = "a".repeat(40);

describe("the hive's events", () => {
	it("says what each writing tool call did, and nothing for settings", () => {
		const claim = { repo: "r", change: "login", agent: "ann", paths: ["src/"], intent: "Add a login page" };
		expect(toolEvent("claim", claim, undefined, NOW)).toEqual({
			kind: "claimed",
			agent: "ann",
			change: "login",
			detail: "Add a login page",
			at: NOW.toISOString(),
		});
		const vote = { repo: "r", commit: HEAD, reviewer: "bob", role: "security", verdict: "approve", evidence: "ok" };
		expect(toolEvent("vote", vote, undefined, NOW)).toMatchObject({
			kind: "voted",
			agent: "bob",
			commit: HEAD,
			verdict: "approve",
			detail: "security",
		});
		expect(toolEvent("merge", { repo: "r", change: "login" }, "nuandy/ann", NOW)).toMatchObject({
			kind: "merging",
			agent: "nuandy/ann",
		});
		expect(toolEvent("add_work", { repo: "r", agent: "ann", items: [{}, {}] }, undefined, NOW)).toMatchObject({
			detail: "2 pieces of work",
		});
		expect(toolEvent("settings", { repo: "r", required: 2 }, undefined, NOW)).toBeNull();
	});

	it("shows pushes to changes' branches and landings, but not a deleted branch", () => {
		const at = NOW.getTime();
		expect(
			pushEvents([
				{ change: "login", fork: "f", head: HEAD, at },
				{ change: "old", fork: "f", head: null, at },
			]),
		).toEqual([{ kind: "pushed", change: "login", commit: HEAD, at: NOW.toISOString() }]);
		const failed = { change: "login", head: HEAD, agent: "ann", how: "failed" as const, at: NOW.toISOString() };
		expect(settledEvents([{ ...failed, reasons: ["tests failed"] }])).toEqual([
			{ kind: "failed", agent: "ann", change: "login", commit: HEAD, detail: "tests failed", at: NOW.toISOString() },
		]);
	});

	it("keeps the newest, in order, and an event delivered twice once", () => {
		const at = (second: number) => new Date(NOW.getTime() + second * 1000).toISOString();
		const pushed = (second: number): HiveEvent => ({ kind: "pushed", change: `c${second}`, at: at(second) });
		const log = withEvents([], [pushed(2), pushed(1)]);
		expect(withEvents(log, [pushed(1)]).map((event) => event.change)).toEqual(["c1", "c2"]);
		const many = Array.from({ length: EVENTS_KEPT + 5 }, (_, second) => pushed(second));
		const kept = withEvents([], many);
		expect(kept).toHaveLength(EVENTS_KEPT);
		expect(kept.at(-1)?.change).toBe(`c${EVENTS_KEPT + 4}`);
	});

	it("are kept in the repo's cache from pings, pushes and landings, and each tells open pages", async () => {
		const sent: string[] = [];
		const socket = { send: (message: string) => sent.push(JSON.parse(message).kind) };
		const cache = new RepoCache({ storage: new FakeStorage(), getWebSockets: () => [socket] } as never, {} as never);
		await cache.ping("records", true, [toolEvent("claim", { change: "login", agent: "ann" }, undefined, NOW)!]);
		await cache.notePushes([{ change: "login", fork: "f", head: HEAD, at: NOW.getTime() + 1000 }]);
		const landed = { change: "login", head: HEAD, agent: "ann", how: "landed" as const, at: "2026-10-11T12:00:02Z" };
		await cache.landingSettled("main", [landed]);
		expect((await cache.events()).map((event) => event.kind)).toEqual(["claimed", "pushed", "landed"]);
		expect(sent).toEqual(["records", "pushed", "landing"]);
	});
});
