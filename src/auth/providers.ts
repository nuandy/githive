import type { ProviderProfile } from "./store";

// Sign-in with GitHub and Google through the authorization-code flow with PKCE. Sign-in is refused unless the
// provider returns a verified email.

export type ProviderName = "github" | "google";

export interface ProviderConfig {
	clientId: string;
	clientSecret: string;
}

interface Provider {
	authorizeUrl(input: { clientId: string; redirectUri: string; state: string; challenge: string }): string;
	profile(input: {
		config: ProviderConfig;
		code: string;
		redirectUri: string;
		verifier: string;
	}): Promise<ProviderProfile>;
}

const fail = (message: string): never => {
	throw new Error(`[502] ${message}`);
};

async function json(response: Response, what: string) {
	const text = await response.text();
	if (!response.ok) fail(`${what} failed: ${response.status} ${text.slice(0, 200)}`);
	try {
		return JSON.parse(text);
	} catch {
		return fail(`${what} answered with something other than JSON`);
	}
}

const GITHUB_HEADERS = { "User-Agent": "GitHive", Accept: "application/json" };

export const PROVIDERS: Record<ProviderName, Provider> = {
	github: {
		authorizeUrl: ({ clientId, redirectUri, state, challenge }) => {
			const query = new URLSearchParams({
				client_id: clientId,
				redirect_uri: redirectUri,
				scope: "read:user user:email",
				state,
				code_challenge: challenge,
				code_challenge_method: "S256",
				allow_signup: "true",
			});
			return `https://github.com/login/oauth/authorize?${query}`;
		},
		async profile({ config, code, redirectUri, verifier }) {
			const token = await json(
				await fetch("https://github.com/login/oauth/access_token", {
					method: "POST",
					headers: { ...GITHUB_HEADERS, "Content-Type": "application/json" },
					body: JSON.stringify({
						client_id: config.clientId,
						client_secret: config.clientSecret,
						code,
						redirect_uri: redirectUri,
						code_verifier: verifier,
					}),
				}),
				"GitHub's token exchange",
			);
			if (typeof token.access_token !== "string")
				fail(`GitHub refused the sign-in: ${token.error_description ?? token.error ?? "no token"}`);
			const headers = { ...GITHUB_HEADERS, Authorization: `Bearer ${token.access_token}` };
			const [user, emails] = await Promise.all([
				json(await fetch("https://api.github.com/user", { headers }), "Reading the GitHub user"),
				json(await fetch("https://api.github.com/user/emails", { headers }), "Reading the GitHub user's emails"),
			]);
			const primary = (emails as { email: string; primary: boolean; verified: boolean }[]).find(
				(email) => email.primary && email.verified,
			);
			if (!primary) throw new Error("[403] your GitHub account has no verified primary email");
			return {
				provider: "github",
				providerId: String(user.id),
				email: primary.email,
				name: user.name ?? null,
				avatarUrl: user.avatar_url ?? null,
				login: user.login ?? null,
			};
		},
	},
	google: {
		authorizeUrl: ({ clientId, redirectUri, state, challenge }) => {
			const query = new URLSearchParams({
				client_id: clientId,
				redirect_uri: redirectUri,
				response_type: "code",
				scope: "openid email profile",
				state,
				code_challenge: challenge,
				code_challenge_method: "S256",
				prompt: "select_account",
			});
			return `https://accounts.google.com/o/oauth2/v2/auth?${query}`;
		},
		async profile({ config, code, redirectUri, verifier }) {
			const token = await json(
				await fetch("https://oauth2.googleapis.com/token", {
					method: "POST",
					headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
					body: new URLSearchParams({
						code,
						client_id: config.clientId,
						client_secret: config.clientSecret,
						redirect_uri: redirectUri,
						grant_type: "authorization_code",
						code_verifier: verifier,
					}),
				}),
				"Google's token exchange",
			);
			if (typeof token.access_token !== "string") fail("Google refused the sign-in");
			const user = await json(
				await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
					headers: { Authorization: `Bearer ${token.access_token}` },
				}),
				"Reading the Google user",
			);
			if (!user.email || user.email_verified !== true)
				throw new Error("[403] your Google account's email isn't verified");
			return {
				provider: "google",
				providerId: String(user.sub),
				email: user.email,
				name: user.name ?? null,
				avatarUrl: user.picture ?? null,
			};
		},
	},
};

export const isProvider = (name: string): name is ProviderName => name === "github" || name === "google";

/** The S256 PKCE challenge for a verifier. */
export async function pkceChallenge(verifier: string) {
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
	return btoa(String.fromCharCode(...digest))
		.replaceAll("+", "-")
		.replaceAll("/", "_")
		.replace(/=+$/, "");
}
