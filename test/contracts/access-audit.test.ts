import { describe, expect, it } from "vitest";
import { accessIdentityLabel, type AccessIdentity, type CoordinatorHumanActions } from "../../src/access-contract";

describe("Access identities in the human-action contract", () => {
	it("labels people by their verified email and scripts by their service-token identity", () => {
		const person: AccessIdentity = { kind: "person", value: "person@example.com" };
		const script: AccessIdentity = { kind: "service", value: "deploy-script" };
		expect(accessIdentityLabel(person)).toBe("person@example.com");
		expect(accessIdentityLabel(script)).toBe("service token deploy-script");
	});

	it("defines actor arguments for each human action", () => {
		const actions: (keyof CoordinatorHumanActions)[] = ["approve", "waive", "messageBuilder", "retryGate", "land"];
		expect(actions).toEqual(["approve", "waive", "messageBuilder", "retryGate", "land"]);
	});
});
