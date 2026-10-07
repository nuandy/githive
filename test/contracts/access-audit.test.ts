import { describe, expect, it } from "vitest";
import { accessIdentityLabel, type AccessIdentity } from "../../src/access-contract";

describe("Access identities", () => {
	it("labels people by their verified email and scripts by their service-token identity", () => {
		const person: AccessIdentity = { kind: "person", value: "person@example.com" };
		const script: AccessIdentity = { kind: "service", value: "deploy-script" };
		expect(accessIdentityLabel(person)).toBe("person@example.com");
		expect(accessIdentityLabel(script)).toBe("service token deploy-script");
	});
});
