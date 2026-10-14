import { describe, expect, it } from "vitest";
import { ApiError } from "../api";
import { messageOf, reasonOf, sentence, statusOf } from "./errors";

describe("an error, in words", () => {
	it("says the server's words as a sentence: a capital and a full stop", () => {
		expect(messageOf(new Error("you already have an agent named builder"))).toBe(
			"You already have an agent named builder.",
		);
		expect(messageOf(new Error("sign in to GitHive first"))).toBe("Sign in to GitHive first.");
		expect(messageOf("the reset couldn't claim the repo")).toBe("The reset couldn't claim the repo.");
	});

	it("leaves a sentence that's already one as it is", () => {
		expect(messageOf(new Error("Your session ended: sign in to GitHive again."))).toBe(
			"Your session ended: sign in to GitHive again.",
		);
		expect(sentence("Is it there?")).toBe("Is it there?");
		expect(sentence("  Spaces around it  ")).toBe("Spaces around it.");
	});

	it("keeps a name at the start as it's written", () => {
		expect(messageOf(new Error("robin/widgets exists"))).toBe("robin/widgets exists.");
		expect(messageOf(new Error("acme-labs is taken"))).toBe("acme-labs is taken.");
		expect(messageOf(new Error("@acme/payments exists"))).toBe("@acme/payments exists.");
		expect(messageOf(new Error("ghv_x9 is revoked"))).toBe("ghv_x9 is revoked.");
	});

	it("keeps the server's words as they are, to set inside a sentence", () => {
		expect(reasonOf(new Error("no repo acme/x"))).toBe("no repo acme/x");
		expect(reasonOf("offline")).toBe("offline");
	});

	it("says nothing for an empty message rather than a lone full stop", () => {
		expect(messageOf(new Error(""))).toBe("");
	});

	it("knows the HTTP status a call failed with, when it did", () => {
		expect(statusOf(new ApiError("robin/widgets exists", 409))).toBe(409);
		expect(statusOf(new Error("offline"))).toBeUndefined();
		expect(statusOf("offline")).toBeUndefined();
	});
});
