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

	if (claims.type === "app") {
		const subject = usableString(claims.sub);
		return subject ? { kind: "service", value: subject } : null;
	}

	const email = usableString(claims.email);
	return email ? { kind: "person", value: email } : null;
}

/** Verify a Cloudflare Access assertion with the signing keys published by its team. */
export const verifyAccessRequest: AccessVerifier = async (request, config) => {
	try {
		if (
			!config ||
			typeof config.teamDomain !== "string" ||
			!validTeamDomain(config.teamDomain) ||
			typeof config.audience !== "string" ||
			!config.audience.trim()
		)
			return null;

		const assertion = request.headers.get("Cf-Access-Jwt-Assertion");
		if (!assertion) return null;
		const segments = assertion.split(".");
		if (segments.length !== 3 || segments.some((part) => !part)) return null;

		const header = decodeJson<JwtHeader>(segments[0]);
		const signature = decodeBase64Url(segments[2]);
		if (!header || header.alg !== "RS256" || typeof header.kid !== "string" || !header.kid || !signature) return null;

		const jwksResponse = await fetch(`https://${config.teamDomain}/cdn-cgi/access/certs`);
		if (!jwksResponse.ok) return null;
		const jwks = (await jwksResponse.json()) as JsonWebKeySet;
		if (!jwks || !Array.isArray(jwks.keys)) return null;
		const jwk = jwks.keys.find(
			(key) => key.kid === header.kid && key.kty === "RSA" && (!key.use || key.use === "sig") && (!key.alg || key.alg === "RS256"),
		);
		if (!jwk) return null;

		const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
		const signingInput = new TextEncoder().encode(`${segments[0]}.${segments[1]}`);
		if (!(await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, signature, signingInput))) return null;

		const claims = decodeJson<AccessJwtClaims>(segments[1]);
		if (!claims || typeof claims !== "object") return null;
		const now = Date.now() / 1000;
		const audienceMatches =
			claims.aud === config.audience ||
			(Array.isArray(claims.aud) && claims.aud.some((audience) => audience === config.audience));
		if (
			claims.iss !== `https://${config.teamDomain}` ||
			!audienceMatches ||
			typeof claims.exp !== "number" ||
			!Number.isFinite(claims.exp) ||
			claims.exp <= now ||
			(claims.nbf !== undefined && (typeof claims.nbf !== "number" || !Number.isFinite(claims.nbf) || claims.nbf > now))
		)
			return null;

		return identify(claims);
	} catch {
		// Missing/bad assertions, unavailable JWKS, malformed keys, and crypto errors all fail closed.
		return null;
	}
};
