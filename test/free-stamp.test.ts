import { describe, expect, it } from "vitest";
import { generateStampKey, identityLabel, makeStamper, verifyStamp } from "../src/free/stamp";

// Verified identity in coordinator-free mode: the toolkit stamps what it writes
// with the caller's Access identity, signed with Blueprint's Ed25519 key. The
// public key is in the registry, so anyone can check a stamp from Git alone.

describe("stamps", () => {
	it("verify for the payload and key they were made with, and nothing else", async () => {
		const key = await generateStampKey();
		const stamper = await makeStamper(key.privateKey, "service:agent-a");
		const stamp = await stamper.stamp("claim src/a/");
		expect(await verifyStamp(key.publicKey, "claim src/a/", stamp)).toBe(true);
		expect(await verifyStamp(key.publicKey, "claim src/b/", stamp)).toBe(false);
		expect(await verifyStamp((await generateStampKey()).publicKey, "claim src/a/", stamp)).toBe(false);
		expect(await verifyStamp(key.publicKey, "claim src/a/", "not-a-stamp")).toBe(false);
	});

	it("name a service by its name and a person by a hash of their email, never the email itself", async () => {
		expect(identityLabel({ kind: "service", value: "deploy-bot" })).toBe("service:deploy-bot");
		const person = identityLabel({ kind: "person", value: "someone@example.com" });
		expect(person).toMatch(/^person:[0-9a-f]{12}$/);
		expect(person).not.toContain("someone");
		expect(identityLabel({ kind: "person", value: "Someone@Example.com " })).toBe(person);
	});
});
