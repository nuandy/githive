// Signing in to GitHive and connecting agents: the pure parts the sign-in
// screen and the Agents page share.

export type Provider = "github" | "google";

export const PROVIDER_NAMES: Record<Provider, string> = { github: "GitHub", google: "Google" };

/** What the server's `?signin_error=` codes mean, to the person who just tried. */
const SIGNIN_ERRORS: Record<string, string> = {
	"not-invited":
		"GitHive is invite-only for now. Your request to join is noted: once an admin approves it, sign in again.",
	expired: "That sign-in took too long or was opened in another tab. Try again.",
	cancelled: "Sign-in was cancelled.",
	"unverified-email": "Your account's email isn't verified with the provider.",
	"provider-failed": "GitHub or Google didn't answer. Try again.",
	"wrong-invite-code": "That invite code isn't right, or it no longer works. Check it and try again.",
};

export function signinErrorMessage(code: string | null | undefined): string | null {
	if (!code) return null;
	return SIGNIN_ERRORS[code] ?? "Sign-in didn't work. Try again.";
}

/** The `signin_error` code in a URL's query, if any. */
export function signinErrorOf(search: string): string | null {
	return new URLSearchParams(search).get("signin_error");
}

// A request to join comes back with the email it's noted under in the fragment, which the browser never sends on.
// Anyone can link here with any fragment, so only what looks like an email is shown.
const ACCOUNT_FRAGMENT = "#signin-as=";
/** One @ with something either side, and no whitespace or control characters. */
const EMAIL = /^[^@\s\p{Cc}]+@[^@\s\p{Cc}]+$/u;
/** The longest an email address can be. */
const EMAIL_MOST = 254;

/** The email a request to join is noted under (`#signin-as=`), if the address carries one. */
export function signinAccountOf(hash: string): string | null {
	if (!hash.startsWith(ACCOUNT_FRAGMENT)) return null;
	try {
		const account = decodeURIComponent(hash.slice(ACCOUNT_FRAGMENT.length));
		return account.length <= EMAIL_MOST && EMAIL.test(account) ? account : null;
	} catch {
		return null;
	}
}

/** The same URL without `signin_error` (or the account a request is noted under), for history.replaceState. */
export function withoutSigninError(url: string): string {
	const parsed = new URL(url);
	parsed.searchParams.delete("signin_error");
	const hash = parsed.hash.startsWith(ACCOUNT_FRAGMENT) ? "" : parsed.hash;
	return `${parsed.pathname}${parsed.search}${hash}`;
}

/**
 * Where a sign-in button goes: the provider, then back to the page the person was on (a path on this site), with
 * the invite code they typed, if any.
 */
export function signInHref(provider: Provider, hash: string, invite = ""): string {
	const fragment = hash && !hash.startsWith("#") ? `#${hash}` : hash;
	const back = `/${fragment}`;
	const code = invite.trim() ? `&invite=${encodeURIComponent(invite.trim())}` : "";
	return `/auth/${provider}?return=${encodeURIComponent(back)}${code}`;
}

/** The invite code a link carries (`?invite=`), so the sign-in screen can fill it in. */
export function inviteOf(search: string): string {
	return new URLSearchParams(search).get("invite") ?? "";
}

/** How long a new agent token lasts: the choices, 90 days first chosen. */
export const TOKEN_EXPIRY: { days: number | null; label: string }[] = [
	{ days: 30, label: "30 days" },
	{ days: 90, label: "90 days" },
	{ days: 365, label: "1 year" },
	{ days: null, label: "Never" },
];
export const DEFAULT_TOKEN_DAYS = 90;

/** The expiry select's value for a choice ("never" for no expiry), and back. */
export const expiryValue = (days: number | null) => (days === null ? "never" : String(days));
export function expiryFromValue(value: string): number | null {
	if (value === "never") return null;
	const days = Number(value);
	return TOKEN_EXPIRY.some((choice) => choice.days === days) ? days : DEFAULT_TOKEN_DAYS;
}

/** The MCP clients the Agents page has steps for; "other" is any client that speaks MCP over HTTP. */
export type McpClient = "claude-code" | "codex" | "other";
export const MCP_CLIENTS: { id: McpClient; label: string }[] = [
	{ id: "claude-code", label: "Claude Code" },
	{ id: "codex", label: "Codex" },
	{ id: "other", label: "Another client" },
];
export const isMcpClient = (value: unknown): value is McpClient => MCP_CLIENTS.some((c) => c.id === value);

/** One step of connecting: what to do (`code` in backticks), and a command or text to copy, if any. */
export interface ConnectStep {
	text: string;
	copy?: string;
}

/** Connecting a client by signing in through the browser (OAuth): nothing secret to copy. */
export function connectSteps(client: McpClient, origin: string): ConnectStep[] {
	const url = `${origin}/mcp`;
	const choose = (who: string) => ({
		text: `Your browser opens GitHive: choose the agent ${who} acts as, or name a new one.`,
	});
	if (client === "claude-code")
		return [
			{
				text: "Add GitHive to Claude Code, in your terminal:",
				copy: `claude mcp add --scope user --transport http githive ${url}`,
			},
			{ text: "In Claude Code, run `/mcp` and choose `githive` to sign in." },
			choose("Claude Code"),
		];
	if (client === "codex")
		return [
			{ text: "Add GitHive to Codex, in your terminal:", copy: `codex mcp add githive --url ${url}` },
			{ text: "Sign in:", copy: "codex mcp login githive" },
			choose("Codex"),
		];
	return [
		{ text: "Add an MCP server that uses the streamable HTTP transport, at:", copy: url },
		{
			text:
				"When the client asks you to sign in, it opens GitHive (OAuth 2.1, with dynamic client " +
				"registration). Choose the agent it acts as, or name a new one.",
		},
	];
}

/** What to ask a new agent first: a small piece of real work, through GitHive, in one of your repos. */
export const workPrompt = (repo: string) => `Use GitHive to improve the README in ${repo}.`;

/** Connecting a client with an agent token: what to copy, with the token filled in. */
export function tokenSteps(client: McpClient, origin: string, token: string): ConnectStep[] {
	const url = `${origin}/mcp`;
	if (client === "claude-code")
		return [
			{
				text: "Connect Claude Code with it:",
				copy:
					`claude mcp add --scope user --transport http githive ${url} --header "Authorization: ` + `Bearer ${token}"`,
			},
		];
	if (client === "codex")
		return [
			{
				text: "Put it where Codex can read it, for example in your shell profile:",
				copy: `export GITHIVE_TOKEN=${token}`,
			},
			{
				text: "Then add GitHive to `~/.codex/config.toml`:",
				copy: `[mcp_servers.githive]\nurl = "${url}"\nbearer_token_env_var = "GITHIVE_TOKEN"`,
			},
		];
	return [
		{ text: "Point the client at the server:", copy: url },
		{ text: "And send this header with every request:", copy: `Authorization: Bearer ${token}` },
	];
}

/** A token as the Agents page lists it: its first characters, never the whole secret. */
export const tokenLabel = (prefix: string) => `ghv_${prefix}…`;

/** A calendar date for an expiry, as YYYY-MM-DD; "never" for none. */
export const expiryDate = (iso: string | null) => (iso ? iso.slice(0, 10) : "never");
