import { describe, expect, it } from "vitest";
import { DEFAULT_TOKEN_DAYS, TOKEN_EXPIRY, expiryDate, expiryFromValue, expiryValue, mcpCommands, signInHref, signinErrorMessage, signinErrorOf, tokenLabel, withoutSigninError } from "./session";

describe("signing in", () => {
	it("says what each failed sign-in means", () => {
		expect(signinErrorMessage("not-invited")).toBe("This email isn't invited to GitHive yet. Ask an admin for an invitation.");
		expect(signinErrorMessage("expired")).toBe("That sign-in took too long or was opened in another tab. Try again.");
		expect(signinErrorMessage("cancelled")).toBe("Sign-in was cancelled.");
		expect(signinErrorMessage("unverified-email")).toBe("Your account's email isn't verified with the provider.");
		expect(signinErrorMessage("provider-failed")).toBe("GitHub or Google didn't answer. Try again.");
		expect(signinErrorMessage("something-new")).toBe("Sign-in didn't work. Try again.");
		expect(signinErrorMessage(null)).toBeNull();
	});

	it("reads the error from the address, and drops it without touching the rest", () => {
		expect(signinErrorOf("?signin_error=not-invited")).toBe("not-invited");
		expect(signinErrorOf("")).toBeNull();
		expect(withoutSigninError("https://githive.app/?signin_error=expired#/repos/docs")).toBe("/#/repos/docs");
		expect(withoutSigninError("https://githive.app/?keep=1&signin_error=expired")).toBe("/?keep=1");
	});

	it("sends a sign-in back to the page the person was on, as a path on this site", () => {
		expect(signInHref("github", "#/repos/docs")).toBe(`/auth/github?return=${encodeURIComponent("/#/repos/docs")}`);
		expect(signInHref("google", "")).toBe(`/auth/google?return=${encodeURIComponent("/")}`);
	});
});

describe("agent tokens", () => {
	it("offers 30, 90 and 365 days or never, 90 by default", () => {
		expect(TOKEN_EXPIRY.map((c) => c.days)).toEqual([30, 90, 365, null]);
		expect(DEFAULT_TOKEN_DAYS).toBe(90);
		for (const choice of TOKEN_EXPIRY) expect(expiryFromValue(expiryValue(choice.days))).toBe(choice.days);
		expect(expiryFromValue("7")).toBe(90);
	});

	it("shows a token by its first characters, and its expiry as a date", () => {
		expect(tokenLabel("Ab3dEf9h")).toBe("ghv_Ab3dEf9h…");
		expect(expiryDate("2027-01-06T12:00:00.000Z")).toBe("2027-01-06");
		expect(expiryDate(null)).toBe("never");
	});

	it("writes the Claude Code commands for this address, over OAuth or with a token", () => {
		expect(mcpCommands("https://githive.app")).toEqual({
			oauth: "claude mcp add --transport http githive https://githive.app/mcp",
			token: 'claude mcp add --transport http githive https://githive.app/mcp --header "Authorization: Bearer <token>"',
		});
		expect(mcpCommands("https://githive.app", "ghv_x").token).toContain('"Authorization: Bearer ghv_x"');
	});
});
