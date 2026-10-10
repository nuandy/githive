import { describe, expect, it } from "vitest";
import { codeInviteLabel, inviteCodeMatches } from "../src/auth/invite-code";
import { IdentityStore, type ProviderProfile } from "../src/auth/store";
import { fakeD1 } from "./fakes/d1";

// A shared invite code: whoever signs in with it is invited, and keeps access only while it's the site's code.

const CODE = "hive-judges-2026";
const judge: ProviderProfile = { provider: "github", providerId: "301", email: "judge@example.com", login: "judge" };

/** A judge let in by the code, with a session and an agent token, and stores that see the code set, gone or changed. */
async function letInByCode() {
	const db = fakeD1();
	const withCode = new IdentityStore(db, undefined, CODE);
	await withCode.invite(judge.email, await codeInviteLabel(CODE));
	const { user } = (await withCode.signIn(judge)) as { user: { id: string } };
	const agent = await withCode.createAgent(user.id, "claude");
	const session = await withCode.createSession(user.id);
	const { token } = await withCode.createToken(user.id, agent.id);
	const stores = {
		withCode,
		deleted: new IdentityStore(db, undefined, undefined),
		changed: new IdentityStore(db, undefined, "another-code"),
	};
	return { stores, session, token, agentId: agent.id };
}

describe("the invite code", () => {
	it("matches only the site's code, and nothing when none is set", async () => {
		expect(await inviteCodeMatches(CODE, ` ${CODE} `)).toBe(true);
		expect(await inviteCodeMatches(CODE, "hive-judges-2025")).toBe(false);
		expect(await inviteCodeMatches(undefined, CODE)).toBe(false);
		expect(await inviteCodeMatches(CODE, undefined)).toBe(false);
	});

	it("marks its invitations with a digest, never the code", async () => {
		const label = await codeInviteLabel(CODE);
		expect(label).toMatch(/^invite code [0-9a-f]{16}$/);
		expect(label).not.toContain(CODE);
	});

	it("lets the people it invited in while it's the site's code", async () => {
		const { stores, session, token, agentId } = await letInByCode();
		expect(await stores.withCode.signIn(judge)).toMatchObject({ user: { handle: "judge" } });
		expect(await stores.withCode.sessionUser(session)).toMatchObject({ handle: "judge" });
		expect(await stores.withCode.tokenPrincipal(token)).toMatchObject({ agent: { name: "claude" } });
		expect(await stores.withCode.activeAgent(agentId)).toMatchObject({ user: { handle: "judge" } });
	});

	it("shuts out everyone it let in once it's deleted or changed: sign-in, sessions, tokens and connections", async () => {
		const { stores, session, token, agentId } = await letInByCode();
		for (const ids of [stores.deleted, stores.changed]) {
			expect(await ids.signIn(judge)).toEqual({ refused: "not-invited" });
			expect(await ids.sessionUser(session)).toBeNull();
			expect(await ids.tokenPrincipal(token)).toBeNull();
			expect(await ids.activeAgent(agentId)).toBeNull();
		}
		// Turned away, they wait as a request, for an admin to let them back in.
		expect((await stores.deleted.inviteRequests()).map((request) => request.email)).toEqual([judge.email]);
	});

	it("gives way to an admin's invitation, which keeps them in after the code is gone", async () => {
		const { stores, session } = await letInByCode();
		await stores.deleted.invite(judge.email, "person:admin");
		expect(await stores.deleted.sessionUser(session)).toMatchObject({ handle: "judge" });
		expect(await stores.deleted.inviteRequests()).toEqual([]);
		// A later code doesn't take an admin's invitation back.
		await stores.changed.invite(judge.email, await codeInviteLabel("another-code"));
		expect(await stores.deleted.sessionUser(session)).toMatchObject({ handle: "judge" });
	});

	it("never shuts out someone an admin invited", async () => {
		const db = fakeD1();
		const ids = new IdentityStore(db);
		await ids.invite("ada@example.com", "person:admin");
		const ada = { provider: "github", providerId: "101", email: "ada@example.com", login: "ada" } as const;
		expect(await new IdentityStore(db, undefined, CODE).signIn(ada)).toMatchObject({ user: { handle: "ada" } });
		expect(await ids.signIn(ada)).toMatchObject({ user: { handle: "ada" } });
	});
});
