import { describe, expect, it } from "vitest";
import { identityName } from "./agent";

describe("agent labels", () => {
	it("shortens recorded identities for people", () => {
		expect(identityName("service:abc/agent-a")).toBe("agent-a");
		expect(identityName("service:0123456789abcdef.access")).toBe("agent 01234567");
		expect(identityName("person:1a2b3c4d5e6f")).toBe("person 1a2b3c4d");
		expect(identityName("blueprint-builder")).toBe("Blueprint builder");
		expect(identityName("agent:reviewer-1")).toBe("reviewer-1");
		expect(identityName("someone")).toBe("someone");
		expect(identityName("")).toBeUndefined();
		expect(identityName(undefined)).toBeUndefined();
	});
});
