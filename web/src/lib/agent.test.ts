import { describe, expect, it } from "vitest";
import { agentLabel, identityName, isHosted } from "./agent";

describe("agent labels", () => {
	it("shortens recorded identities for people", () => {
		expect(identityName("service:abc/agent-a")).toBe("agent-a");
		expect(identityName("service:0123456789abcdef.access")).toBe("agent 01234567");
		expect(identityName("person:1a2b3c4d5e6f")).toBe("person 1a2b3c4d");
		expect(identityName("blueprint-builder")).toBe("Blueprint builder");
		expect(identityName("someone")).toBe("someone");
		expect(identityName("")).toBeUndefined();
		expect(identityName(undefined)).toBeUndefined();
	});

	it("falls back to the kind of agent when nobody is recorded", () => {
		expect(agentLabel({ openedBy: "service:abc/agent-a", external: true })).toBe("agent-a");
		expect(agentLabel({ external: true })).toBe("external agent");
		expect(agentLabel({ agent: "docs-agent", openedBy: "service:abc", external: true })).toBe("docs-agent");
		expect(agentLabel({ external: false })).toBe("Blueprint builder");
		expect(agentLabel({})).toBe("Blueprint builder");
	});

	it("tells hosted changes from outside agents", () => {
		expect(isHosted({ external: true })).toBe(false);
		expect(isHosted({ external: false })).toBe(true);
		expect(isHosted({ external: true, openedBy: "blueprint-builder" })).toBe(true);
	});
});
