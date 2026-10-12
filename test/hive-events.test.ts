import { describe, expect, it } from "vitest";
import { EVENTS_KEPT, type HiveEvent, pushEvents, settledEvents, toolEvent } from "../src/hive-events";
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

	it("keeps the newest, in order, and an event delivered twice once", async () => {
		const at = (second: number) => new Date(NOW.getTime() + second * 1000).toISOString();
		const pushed = (second: number): HiveEvent => ({ kind: "pushed", change: `c${second}`, at: at(second) });
		const cache = new RepoCache({ storage: new FakeStorage(), getWebSockets: () => [] } as never, {} as never);
		await cache.ping("records", false, [pushed(2), pushed(1)]);
		await cache.ping("records", false, [pushed(1)]);
		expect((await cache.events()).map((event) => event.change)).toEqual(["c1", "c2"]);
		for (let second = 3; second < EVENTS_KEPT + 8; second++) await cache.ping("records", false, [pushed(second)]);
		const kept = await cache.events();
		expect(kept).toHaveLength(EVENTS_KEPT);
		expect(kept.at(-1)?.change).toBe(`c${EVENTS_KEPT + 7}`);
	});

	it("keeps awareness events one per occurrence: the other agent tells two apart, the detail doesn't", async () => {
		const at = NOW.toISOString();
		const headsUp = (other: string, detail: string): HiveEvent => ({
			kind: "heads_up",
			agent: "bob",
			change: "c-3",
			other,
			detail,
			at,
		});
		const cache = new RepoCache({ storage: new FakeStorage(), getWebSockets: () => [] } as never, {} as never);
		await cache.ping("records", false, [headsUp("carol", "loadSettings"), headsUp("dan", "loadSettings")]);
		await cache.ping("records", false, [headsUp("carol", "saveSettings")]);
		expect((await cache.events()).map((event) => [event.other, event.detail])).toEqual([
			["carol", "saveSettings"],
			["dan", "loadSettings"],
		]);
		// One agent's two changes in the same moment are two heads-ups.
		const twice = [
			{ ...headsUp("erin", "loadSettings"), otherChange: "e-1" },
			{ ...headsUp("erin", "loadSettings"), otherChange: "e-2" },
		];
		await cache.ping("records", false, twice);
		expect((await cache.events()).filter((event) => event.other === "erin").map((event) => event.otherChange)).toEqual([
			"e-1",
			"e-2",
		]);
	});

	it("keeps one conflicted event for each change and head, however often its agent merges it again", async () => {
		const cache = new RepoCache({ storage: new FakeStorage(), getWebSockets: () => [] } as never, {} as never);
		const conflicted = (second: number, commit: string): HiveEvent => ({
			kind: "conflicted",
			agent: "bob",
			change: "c-3",
			commit,
			detail: "a.ts",
			at: new Date(NOW.getTime() + second * 1000).toISOString(),
		});
		for (let second = 0; second < 5; second++) await cache.ping("records", false, [conflicted(second, HEAD)]);
		await cache.ping("records", false, [conflicted(9, "b".repeat(40))]);
		expect((await cache.events()).map((event) => event.commit)).toEqual([HEAD, "b".repeat(40)]);
	});

	it("moves a log kept as one list under keys of its own", async () => {
		const storage = new FakeStorage();
		await storage.put("events", [{ kind: "pushed", change: "old", at: NOW.toISOString() }]);
		const cache = new RepoCache({ storage, getWebSockets: () => [] } as never, {} as never);
		expect((await cache.events()).map((event) => event.change)).toEqual(["old"]);
		expect(await storage.get("events")).toBeUndefined();
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
