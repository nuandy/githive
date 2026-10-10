import { createHash } from "node:crypto";
import type { AccessIdentity } from "../access-contract";

// Verified identity for GitHive. What the toolkit writes (claims,
// releases, votes, merges) carries `by`, the caller's identity as Cloudflare
// Access verified it, and a stamp: an Ed25519 signature by GitHive's key over
// the whole record. The public key is in the claims registry's first entry, so
// anyone can check a stamp from Git alone. Anything written around the toolkit
// has no valid stamp, and the audit says so rather than trusting a name.

const ALGORITHM = { name: "Ed25519" } as const;
const encoder = new TextEncoder();

const toBase64 = (bytes: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(bytes)));
const fromBase64 = (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

/**
 * Who did something, for the records: a service by its name, a person by a
 * hash of their email. Records are read by agents and their models, so emails
 * never go in them; anyone who knows the email can still check the hash.
 */
export function identityLabel(identity: AccessIdentity): string {
	if (identity.kind === "service") return `service:${identity.value}`;
	return `person:${createHash("sha256").update(identity.value.trim().toLowerCase()).digest("hex").slice(0, 12)}`;
}

/** A new signing key pair: the private key (PKCS #8) for the secret, the raw public key for the registry, both base64. */
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
	/** GitHive's public key, as the registry records it. */
	publicKey: string;
	stamp(payload: string): Promise<string>;
}

/** Stamps for one caller, from GitHive's private key. */
export async function makeStamper(privateKey: string, by: string): Promise<Stamper> {
	const key = await crypto.subtle.importKey("pkcs8", fromBase64(privateKey), ALGORITHM, true, ["sign"]);
	const jwk = (await crypto.subtle.exportKey("jwk", key)) as JsonWebKey;
	const publicKey = jwk.x
		? toBase64(
				fromBase64(
					jwk.x
						.replace(/-/g, "+")
						.replace(/_/g, "/")
						.padEnd(Math.ceil(jwk.x.length / 4) * 4, "="),
				),
			)
		: "";
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
	const sorted = (value: unknown): unknown =>
		Array.isArray(value)
			? value.map(sorted)
			: value && typeof value === "object"
				? Object.fromEntries(
						Object.entries(value)
							.sort(([a], [b]) => a.localeCompare(b))
							.map(([k, v]) => [k, sorted(v)]),
					)
				: value;
	return `${kind}\n${JSON.stringify(sorted(rest))}`;
}
