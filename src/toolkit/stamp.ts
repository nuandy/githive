import { createHash } from "node:crypto";
import type { AccessIdentity } from "../access-contract";

// Verified identity. Everything the toolkit writes carries `by`, the caller's identity as Cloudflare Access
// verified it, and a stamp: GitHive's Ed25519 signature over the whole record. The public key is in the claims
// registry's first entry, so anyone can check a stamp from Git alone, and the audit flags records without one.

const ALGORITHM = { name: "Ed25519" } as const;
const encoder = new TextEncoder();

const toBase64 = (bytes: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(bytes)));
const fromBase64 = (text: string) => Uint8Array.from(atob(text), (char) => char.charCodeAt(0));
// A JWK's base64url as plain base64.
const fromBase64Url = (text: string) =>
	text
		.replace(/-/g, "+")
		.replace(/_/g, "/")
		.padEnd(Math.ceil(text.length / 4) * 4, "=");

/**
 * Who did something, for the records. A person appears as a hash of their email, because agents and their
 * models read the records; anyone who knows the email can still check the hash.
 */
export function identityLabel(identity: AccessIdentity): string {
	if (identity.kind === "service") return `service:${identity.value}`;
	const hash = createHash("sha256").update(identity.value.trim().toLowerCase()).digest("hex");
	return `person:${hash.slice(0, 12)}`;
}

/** A new key pair in base64: the PKCS #8 private key for the secret, the raw public key for the registry. */
export async function generateStampKey() {
	const pair = (await crypto.subtle.generateKey(ALGORITHM, true, ["sign", "verify"])) as CryptoKeyPair;
	return {
		privateKey: toBase64((await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer),
		publicKey: toBase64((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer),
	};
}

export interface Stamper {
	/** The verified identity of whoever the toolkit is acting for. */
	by: string;
	publicKey: string;
	stamp(payload: string): Promise<string>;
}

export async function makeStamper(privateKey: string, by: string): Promise<Stamper> {
	const key = await crypto.subtle.importKey("pkcs8", fromBase64(privateKey), ALGORITHM, true, ["sign"]);
	const jwk = (await crypto.subtle.exportKey("jwk", key)) as JsonWebKey;
	const publicKey = jwk.x ? toBase64(fromBase64(fromBase64Url(jwk.x))) : "";
	return {
		by,
		publicKey,
		stamp: async (payload) => toBase64(await crypto.subtle.sign(ALGORITHM, key, encoder.encode(payload))),
	};
}

/** Whether `stamp` is GitHive's signature (with `publicKey`) over `payload`. */
export async function verifyStamp(publicKey: string, payload: string, stamp: string | undefined): Promise<boolean> {
	if (!stamp) return false;
	try {
		const key = await crypto.subtle.importKey("raw", fromBase64(publicKey), ALGORITHM, false, ["verify"]);
		return await crypto.subtle.verify(ALGORITHM, key, fromBase64(stamp), encoder.encode(payload));
	} catch {
		return false;
	}
}

/** A record as a stable string to stamp: its fields sorted, without its stamp. */
export function stampPayload(kind: string, record: object): string {
	const { stamp: _stamp, ...rest } = record as { stamp?: string };
	return `${kind}\n${JSON.stringify(sortedKeys(rest))}`;
}

// `value` with every object's keys in sorted order, at any depth.
function sortedKeys(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sortedKeys);
	if (!value || typeof value !== "object") return value;
	const entries = Object.entries(value).sort(([a], [b]) => a.localeCompare(b));
	return Object.fromEntries(entries.map(([key, inner]) => [key, sortedKeys(inner)]));
}
