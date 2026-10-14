import { describe, expect, it } from "vitest";
import { roleName } from "./roles";

describe("role names", () => {
	it("names a role's reviewer without saying review twice", () => {
		expect(roleName("review")).toBe("reviewer");
		expect(roleName("security")).toBe("security reviewer");
	});
});
