/** Verified identity extracted from a Cloudflare Access JWT. */
export type AccessIdentity =
	| { kind: "person"; value: string }
	| { kind: "service"; value: string };

export interface AccessConfiguration {
	/** Cloudflare Access team hostname, without a scheme. */
	teamDomain: string;
	/** Access application's audience tag. */
	audience: string;
}

/** The signed claims GitHive uses from a Cloudflare Access assertion. */
export interface AccessJwtClaims {
	iss: string;
	aud: string | string[];
	exp: number;
	nbf?: number;
	iat?: number;
	type?: string;
	email?: string;
	common_name?: string;
	sub?: string;
}

export type AccessVerifier = (
	request: Request,
	config: AccessConfiguration,
) => Promise<AccessIdentity | null>;

/** Stable audit label: an email for a person, or an identified Access service token. */
export function accessIdentityLabel(identity: AccessIdentity): string {
	return identity.kind === "person" ? identity.value : `service token ${identity.value}`;
}
