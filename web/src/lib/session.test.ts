import { describe, expect, it } from "vitest";
import { DEFAULT_TOKEN_DAYS, TOKEN_EXPIRY, expiryDate, expiryFromValue, expiryValue, connectSteps, tokenSteps, signInHref, signinErrorMessage, signinErrorOf, tokenLabel, withoutSigninError } from "./session";

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

	it("connects Claude Code over OAuth: the command, then /mcp to sign in", () => {
		const steps = connectSteps("claude-code", "https://githive.app");
		expect(steps[0].copy).toBe("claude mcp add --scope user --transport http githive https://githive.app/mcp");
		expect(steps[1].text).toContain("`/mcp`");
	});

	it("connects Codex over OAuth: codex mcp add, then codex mcp login", () => {
		expect(connectSteps("codex", "https://githive.app").map((s) => s.copy).filter(Boolean)).toEqual(["codex mcp add githive --url https://githive.app/mcp", "codex mcp login githive"]);
	});

	it("tells any other client the server's address", () => {
		expect(connectSteps("other", "https://githive.app")[0].copy).toBe("https://githive.app/mcp");
	});

	it("fills a new token into each client's setup, and never leaves a placeholder", () => {
		expect(tokenSteps("claude-code", "https://githive.app", "ghv_x")[0].copy).toBe('claude mcp add --scope user --transport http githive https://githive.app/mcp --header "Authorization: Bearer ghv_x"');
		const codex = tokenSteps("codex", "https://githive.app", "ghv_x").map((s) => s.copy);
		expect(codex).toEqual(["export GITHIVE_TOKEN=ghv_x", '[mcp_servers.githive]\nurl = "https://githive.app/mcp"\nbearer_token_env_var = "GITHIVE_TOKEN"']);
		expect(tokenSteps("other", "https://githive.app", "ghv_x").map((s) => s.copy)).toEqual(["https://githive.app/mcp", "Authorization: Bearer ghv_x"]);
		for (const client of ["claude-code", "codex", "other"] as const) expect(JSON.stringify(tokenSteps(client, "https://githive.app", "ghv_x"))).not.toContain("<token>");
	});
});
