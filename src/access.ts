import type { AccessConfiguration, AccessIdentity, AccessJwtClaims, AccessVerifier } from "./access-contract";

interface JwtHeader {
	alg?: unknown;
	kid?: unknown;
}

interface JsonWebKeySet {
	keys?: (JsonWebKey & { kid?: string; alg?: string; use?: string })[];
}

const decodeBase64Url = (value: string): Uint8Array | null => {
	if (!value || !/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1) return null;
	try {
		const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
		const binary = atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4));
		return Uint8Array.from(binary, (character) => character.charCodeAt(0));
	} catch {
		return null;
	}
};

const decodeJson = <T>(value: string): T | null => {
	const bytes = decodeBase64Url(value);
	if (!bytes) return null;
	try {
		return JSON.parse(new TextDecoder().decode(bytes)) as T;
	} catch {
		return null;
	}
};

const validTeamDomain = (domain: string) =>
	/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/.test(domain);

const usableString = (value: unknown): string | null =>
	typeof value === "string" && value.trim().length > 0 ? value.trim() : null;

function identify(claims: AccessJwtClaims): AccessIdentity | null {
	const serviceName = usableString(claims.common_name);
	if (serviceName) return { kind: "service", value: serviceName };

	// A person's browser session is also an "app" token, but it carries their email.
	const email = usableString(claims.email);
	if (email) return { kind: "person", value: email };

	if (claims.type === "app") {
		const subject = usableString(claims.sub);
		return subject ? { kind: "service", value: subject } : null;
	}
	return null;
}

function usableConfig(config: AccessConfiguration | undefined | null): config is AccessConfiguration {
	if (!config || typeof config.teamDomain !== "string" || !validTeamDomain(config.teamDomain)) return false;
	return typeof config.audience === "string" && !!config.audience.trim();
}

async function findSigningKey(teamDomain: string, keyId: string) {
	const jwksResponse = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`);
	if (!jwksResponse.ok) return null;
	const jwks = (await jwksResponse.json()) as JsonWebKeySet;
	if (!jwks || !Array.isArray(jwks.keys)) return null;
	const jwk = jwks.keys.find(
		(key) =>
			key.kid === keyId && key.kty === "RSA" && (!key.use || key.use === "sig") && (!key.alg || key.alg === "RS256"),
	);
	return jwk ?? null;
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function claimsAreValid(claims: AccessJwtClaims, config: AccessConfiguration) {
	const now = Date.now() / 1000;
	const audienceMatches =
		claims.aud === config.audience ||
		(Array.isArray(claims.aud) && claims.aud.some((audience) => audience === config.audience));
	if (claims.iss !== `https://${config.teamDomain}` || !audienceMatches) return false;
	if (!isFiniteNumber(claims.exp) || claims.exp <= now) return false;
	if (claims.nbf === undefined) return true;
	return isFiniteNumber(claims.nbf) && claims.nbf <= now;
}

/** Verify a Cloudflare Access assertion with the signing keys published by its team. */
export const verifyAccessRequest: AccessVerifier = async (request, config) => {
	try {
		if (!usableConfig(config)) return null;

		const assertion = request.headers.get("Cf-Access-Jwt-Assertion");
		if (!assertion) return null;
		const segments = assertion.split(".");
		const [encodedHeader, encodedClaims, encodedSignature] = segments;
		if (segments.length !== 3 || !encodedHeader || !encodedClaims || !encodedSignature) return null;

		const header = decodeJson<JwtHeader>(encodedHeader);
		const signature = decodeBase64Url(encodedSignature);
		if (!header || header.alg !== "RS256" || typeof header.kid !== "string" || !header.kid || !signature) return null;

		const jwk = await findSigningKey(config.teamDomain, header.kid);
		if (!jwk) return null;

		const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, [
			"verify",
		]);
		const signingInput = new TextEncoder().encode(`${encodedHeader}.${encodedClaims}`);
		if (!(await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, signature, signingInput))) return null;

		const claims = decodeJson<AccessJwtClaims>(encodedClaims);
		if (!claims || typeof claims !== "object" || !claimsAreValid(claims, config)) return null;

		return identify(claims);
	} catch {
		// Missing/bad assertions, unavailable JWKS, malformed keys, and crypto errors all fail closed.
		return null;
	}
};
