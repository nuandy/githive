import { describe, expect, it, vi } from "vitest";
import { FakeStorage } from "./fakes/env";

// A repo's RepoCache rings its hosted agents when something changes: a tool's write, a landing, a push or a notice. It
// rings only a repo whose hive asked, and stops once none of its agents is running.

const { RepoCache } = await import("../src/repo-cache");

function repoCache(running: () => boolean | Promise<boolean>) {
	const rings: [string, string][] = [];
	const HOSTED_AGENT = {
		getByName: (name: string) => ({
			ringAgents: async (reason: string) => {
				rings.push([name, reason]);
				return running();
			},
		}),
	};
	const storage = new FakeStorage();
	const cache = new RepoCache({ storage, getWebSockets: () => [] } as never, { HOSTED_AGENT } as never);
	return { cache, rings, storage };
}

describe("ringing a repo's hive", () => {
	it("rings with the tool that wrote, a landing or a push, once the hive asked", async () => {
		const { cache, rings } = repoCache(() => true);
		await cache.ping("records", true, [], "claim");
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(rings).toEqual([]);
		await cache.hiveListens("ada--honeycomb");
		await cache.ping("records", true, [], "vote");
		await cache.landingSettled("main", [
			{ change: "a", head: "h", agent: "bee", how: "landed", at: new Date().toISOString(), commit: "m", files: [] },
		]);
		// A page reading doesn't ring: only a write does.
		await cache.ping("view", false);
		await vi.waitFor(() =>
			expect(rings).toEqual([
				["hive:ada--honeycomb", "vote"],
				["hive:ada--honeycomb", "landed"],
			]),
		);
	});

	it("rings for a notice left for an agent, and wakes a held wait, with the notice still kept", async () => {
		const { cache, rings } = repoCache(() => true);
		await cache.hiveListens("ada--honeycomb");
		const mark = await cache.rings();
		const held = cache.ringAfter(mark, 5_000);
		const at = new Date().toISOString();
		await cache.notify("main", [{ agent: "bee", notice: { kind: "heads_up", at, says: "a heads-up", change: "c" } }]);
		expect(await held).toBe(mark + 1);
		await vi.waitFor(() => expect(rings).toEqual([["hive:ada--honeycomb", "notice"]]));
		// Waiting reads when the newest notice came without taking it: the agent's next reply tells it.
		expect(await cache.newestNotice("bee")).toBe(at);
		expect((await cache.landingNews("main", "bee")).map((item) => item.kind)).toEqual(["heads_up"]);
		expect(await cache.newestNotice("bee")).toBeNull();
	});

	it("stops ringing once no agent runs, but not a hive started again meanwhile", async () => {
		const { cache, rings, storage } = repoCache(() => false);
		await cache.hiveListens("ada--honeycomb");
		await cache.ping("records", true, [], "release");
		await vi.waitFor(async () => expect(await storage.get("hive")).toBeUndefined());
		await cache.ping("records", true, [], "release");
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(rings).toHaveLength(1);

		// A new hive asks while a ring to the old one is on its way back: the ring's answer is held until then.
		let answer: ((running: boolean) => void) | undefined;
		const onItsWay = () => new Promise<boolean>((resolve) => (answer = resolve));
		const { cache: again, storage: kept } = repoCache(onItsWay);
		await again.hiveListens("ada--honeycomb");
		vi.useFakeTimers({ now: Date.now() + 1_000, toFake: ["Date"] });
		await again.ping("records", true, [], "release");
		await again.hiveListens("ada--honeycomb");
		vi.useRealTimers();
		await vi.waitFor(() => expect(answer).toBeDefined());
		answer!(false);
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(await kept.get("hive")).toBeDefined();
	});
});
