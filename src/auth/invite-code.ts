import { sha256Hex } from "./digest";

// A shared invite code, the INVITE_CODE secret, for people an admin can't name ahead of time. Whoever signs in with
// it is invited, and the invitation is marked with the code's digest, never the code. That access lasts only while
// the code is this site's: delete or change the secret, and everyone it let in is signed out, their agents' tokens
// and connections stop working, and they can't sign in again unless an admin invites them.

/** How an invitation made with an invite code begins; the code's digest follows. */
export const CODE_INVITE = "invite code ";

/** The site's invite code, if one is set. */
export const inviteCodeOf = (env: Env) => (env as unknown as { INVITE_CODE?: string }).INVITE_CODE?.trim() || undefined;

/** How invitations made with `code` are marked. */
export async function codeInviteLabel(code: string) {
	return `${CODE_INVITE}${(await sha256Hex(code.trim())).slice(0, 16)}`;
}

/** Whether `given` is the site's invite code. Their digests are compared in full, so timing tells nothing. */
export async function inviteCodeMatches(code: string | undefined, given: string | undefined) {
	if (!code || !given) return false;
	const [want, got] = await Promise.all([sha256Hex(code.trim()), sha256Hex(given.trim())]);
	let differs = 0;
	for (let i = 0; i < want.length; i++) differs |= want.charCodeAt(i) ^ got.charCodeAt(i);
	return differs === 0;
}
