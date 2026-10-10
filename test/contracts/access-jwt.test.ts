import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { verifyAccessRequest } from "../../src/access";
import type { AccessConfiguration, AccessJwtClaims } from "../../src/access-contract";

const config: AccessConfiguration = {
	teamDomain: "little-cake-3c64.cloudflareaccess.com",
	audience: "40a0a047944251bc67f3291f138b617f8cdb68f342635bd15582a6d770d1fd52",
};
const kid = "access-test-key";
let pair: CryptoKeyPair;
let jwk: JsonWebKey & { kid: string; alg: string; use: string };
const originalFetch = globalThis.fetch;

const encode = (value: string | ArrayBuffer) => {
	const bytes = typeof value === "string" ? new TextEncoder().encode(value) : new Uint8Array(value);
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replaceAll("=", "").replaceAll("+", "-").replaceAll("/", "_");
};

async function token(claims: Partial<AccessJwtClaims> = {}) {
	const now = Math.floor(Date.now() / 1000);
	const payload: AccessJwtClaims = {
		iss: `https://${config.teamDomain}`,
		aud: config.audience,
		exp: now + 300,
		email: "dev@example.com",
		...claims,
	};
	const signingInput = `${encode(JSON.stringify({ alg: "RS256", kid, typ: "JWT" }))}.${encode(JSON.stringify(payload))}`;
	const signature = await crypto.subtle.sign(
		"RSASSA-PKCS1-v1_5",
		pair.privateKey,
		new TextEncoder().encode(signingInput),
	);
	return `${signingInput}.${encode(signature)}`;
}

async function verify(jwt: string, overrides: Partial<AccessConfiguration> = {}) {
	return verifyAccessRequest(
		new Request("https://blueprint.nuandy.workers.dev/api", { headers: { "Cf-Access-Jwt-Assertion": jwt } }),
		{ ...config, ...overrides },
	);
}

beforeAll(async () => {
	pair = (await crypto.subtle.generateKey(
		{ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
		true,
		["sign", "verify"],
	)) as CryptoKeyPair;
	jwk = Object.assign((await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey, {
		kid,
		alg: "RS256",
		use: "sig",
	});
});

beforeEach(() => {
	globalThis.fetch = vi.fn(async () => Response.json({ keys: [jwk] })) as unknown as typeof fetch;
});

afterEach(() => {
	globalThis.fetch = originalFetch;
});

describe("Cloudflare Access JWT verification", () => {
	it("verifies the signature and returns the signed person's email", async () => {
		await expect(verify(await token())).resolves.toEqual({ kind: "person", value: "dev@example.com" });
	});

	it("identifies a person's browser session, an app token with their email, as that person", async () => {
		await expect(verify(await token({ type: "app", sub: "5cded567-0ef8-5e1d-beae-1bfd05aec026" }))).resolves.toEqual({
			kind: "person",
			value: "dev@example.com",
		});
	});

	it("identifies an app token with no email or common name by its subject", async () => {
		await expect(verify(await token({ type: "app", sub: "app-subject", email: undefined }))).resolves.toEqual({
			kind: "service",
			value: "app-subject",
		});
	});

	it("identifies a service token from its signed common_name", async () => {
		await expect(
			verify(await token({ type: "app", common_name: "release-script", email: undefined })),
		).resolves.toEqual({ kind: "service", value: "release-script" });
	});

	it("rejects an invalid signature, issuer, audience, or expired assertion", async () => {
		const valid = await token();
		const parts = valid.split(".");
		parts[2] = encode(new Uint8Array(256).buffer);
		await expect(verify(parts.join("."))).resolves.toBeNull();
		await expect(verify(await token({ iss: "https://untrusted.example" }))).resolves.toBeNull();
		await expect(verify(await token({ aud: "wrong-audience" }))).resolves.toBeNull();
		await expect(verify(await token({ exp: Math.floor(Date.now() / 1000) - 1 }))).resolves.toBeNull();
		await expect(verify(await token({ nbf: Math.floor(Date.now() / 1000) + 120 }))).resolves.toBeNull();
	});

	it("rejects assertions without a usable identity and does not trust an unsigned email header", async () => {
		const jwt = await token({ email: undefined });
		await expect(verify(jwt)).resolves.toBeNull();
		await expect(
			verifyAccessRequest(
				new Request("https://blueprint.nuandy.workers.dev/", {
					headers: { "Cf-Access-Authenticated-User-Email": "spoof@example.com" },
				}),
				config,
			),
		).resolves.toBeNull();
	});
});

describe("Worker ingress authentication", () => {
	it("refuses unauthenticated requests for the API, MCP and writes, but serves the page that asks people to sign in", async () => {
		const worker = (await import("../../src/index")).default;
		const assets = { fetch: async () => new Response("<!doctype html>the dashboard") };
		const env = { ACCESS_TEAM_DOMAIN: config.teamDomain, ACCESS_AUD: config.audience, ASSETS: assets } as never;
		for (const [path, method] of [
			["/api", "GET"],
			["/repos", "GET"],
			["/me", "GET"],
			["/repos/import", "POST"],
			["/mcp", "POST"],
			["/admin/invites", "GET"],
		] as const) {
			const response = await worker.fetch(
				new Request(`https://blueprint.nuandy.workers.dev${path}`, { method }),
				env,
				{} as never,
			);
			expect(response.status, `${method} ${path}`).toBe(401);
		}
		const page = await worker.fetch(new Request("https://blueprint.nuandy.workers.dev/"), env, {} as never);
		expect(page.status).toBe(200);
	});
});
