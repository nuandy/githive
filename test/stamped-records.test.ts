import { beforeAll, describe, expect, it } from "vitest";
import { claim, release, startRepo, type Registry } from "../src/toolkit/claims";
import { generateStampKey, makeStamper, stampPayload, type Stamper, verifyStamp } from "../src/toolkit/stamp";
import { vote, type Votes } from "../src/toolkit/votes";
import { MemoryLog } from "./helpers/memory-log";

// What the toolkit writes carries the caller's verified identity and GitHive's
// stamp; the registry's first entry carries the public key to check them with.

let key: { privateKey: string; publicKey: string };
let alice: Stamper;

beforeAll(async () => {
	key = await generateStampKey();
	alice = await makeStamper(key.privateKey, "service:agent-a");
});

describe("stamped records", () => {
	it("records the public key when the mode starts", async () => {
		const log = new MemoryLog<Registry>();
		await startRepo(log, { baseline: "b0", policy: { required: 1, vetoes: [] }, stampKey: key.publicKey });
		expect((await log.read())!.commit.state.stampKey).toBe(key.publicKey);
	});

	it("stamps a claim and its release with who made them", async () => {
		const log = new MemoryLog<Registry>();
		await claim(log, { change: "a-1", agent: "agent-a", paths: ["src/a/"], intent: "a" }, alice);
		const held = (await log.read())!.commit.state.claims[0];
		expect(held.by).toBe("service:agent-a");
		expect(await verifyStamp(key.publicKey, stampPayload("claim", held), held.stamp)).toBe(true);
		await release(log, { change: "a-1", agent: "agent-a", reason: "merged", mergedAs: "m1" }, alice);
		const released = (await log.read())!.commit.state.released[0];
		expect(released.by).toBe("agent-a");
		expect(released.verifiedBy).toBe("service:agent-a");
		expect(await verifyStamp(key.publicKey, stampPayload("release", released), released.stamp)).toBe(true);
	});

	it("stamps a vote with who cast it", async () => {
		const log = new MemoryLog<Votes>();
		await vote(log, { commit: "h1", reviewer: "rev-1", role: "tests", verdict: "approve", evidence: "ok" }, alice);
		const cast = (await log.read())!.commit.state.votes[0];
		expect(cast.by).toBe("service:agent-a");
		expect(await verifyStamp(key.publicKey, stampPayload("vote", cast), cast.stamp)).toBe(true);
	});
});
