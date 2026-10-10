import { describe, expect, it } from "vitest";
import { IdentityStore, type ProviderProfile, sha256Hex } from "../src/auth/store";
import { fakeD1 } from "./fakes/d1";

// GitHive's own identity, against a real SQLite database with the migrations
// applied: who may sign in, how accounts link, sessions, agents and tokens.

let clock = Date.parse("2026-10-08T12:00:00.000Z");
const now = () => new Date(clock);
const store = () => {
	const db = fakeD1();
	return { db, ids: new IdentityStore(db, now) };
};
const github: ProviderProfile = {
	provider: "github",
	providerId: "101",
	email: "Ada@Example.com",
	name: "Ada",
	login: "ada",
};

describe("signing in", () => {
	it("refuses anyone not invited, and lets an invited person in with their GitHub login as handle", async () => {
		const { ids } = store();
		expect(await ids.signIn(github)).toEqual({ refused: "not-invited" });
		await ids.invite("ada@example.com", "person:admin");
		const signed = await ids.signIn(github);
		expect(signed).toMatchObject({ user: { handle: "ada", email: "ada@example.com", name: "Ada" } });
	});

	it("signs the same person in again, and links a second provider with the same verified email", async () => {
		const { ids } = store();
		await ids.invite("ada@example.com", "person:admin");
		const first = (await ids.signIn(github)) as { user: { id: string } };
		expect(((await ids.signIn(github)) as { user: { id: string } }).user.id).toBe(first.user.id);
		const google = (await ids.signIn({ provider: "google", providerId: "g-9", email: "ada@example.com" })) as {
			user: { id: string };
		};
		expect(google.user.id).toBe(first.user.id);
		// Linked now: a changed email at Google still finds the same person.
		expect(
			(
				(await ids.signIn({ provider: "google", providerId: "g-9", email: "other@example.com" })) as {
					user: { id: string };
				}
			).user.id,
		).toBe(first.user.id);
	});

	it("never makes a handle from an email: a Google sign-in gets u-<hex>, and a taken login does too", async () => {
		const { ids } = store();
		await ids.invite("grace@example.com", "person:admin");
		await ids.invite("ada@example.com", "person:admin");
		await ids.invite("imposter@example.com", "person:admin");
		const grace = (await ids.signIn({ provider: "google", providerId: "g-1", email: "grace@example.com" })) as {
			user: { handle: string };
		};
		expect(grace.user.handle).toMatch(/^u-[0-9a-f]{6}$/);
		await ids.signIn(github);
		const clash = (await ids.signIn({
			provider: "github",
			providerId: "202",
			email: "imposter@example.com",
			login: "ada",
		})) as { user: { handle: string } };
		expect(clash.user.handle).toMatch(/^u-[0-9a-f]{6}$/);
	});
});

describe("sessions", () => {
	it("finds the user by the secret, stores only its hash, and ends it on sign-out or after 30 days", async () => {
		const { db, ids } = store();
		await ids.invite("ada@example.com", "person:admin");
		const { user } = (await ids.signIn(github)) as { user: { id: string; handle: string } };
		const secret = await ids.createSession(user.id);
		expect((await ids.sessionUser(secret))?.handle).toBe("ada");
		const stored = (db as unknown as { raw: { prepare(s: string): { get(): Record<string, string> } } }).raw
			.prepare("SELECT id_hash FROM sessions")
			.get();
		expect(stored.id_hash).toBe(await sha256Hex(secret));
		await ids.endSession(secret);
		expect(await ids.sessionUser(secret)).toBeNull();
		const later = await ids.createSession(user.id);
		clock += 31 * 86_400_000;
		expect(await ids.sessionUser(later)).toBeNull();
		clock = Date.parse("2026-10-08T12:00:00.000Z");
	});
});

describe("agents and their tokens", () => {
	const signedIn = async () => {
		const s = store();
		await s.ids.invite("ada@example.com", "person:admin");
		const { user } = (await s.ids.signIn(github)) as { user: { id: string } };
		return { ...s, user };
	};

	it("issues a token once, and finds the agent and its owner by it", async () => {
		const { ids, user } = await signedIn();
		const agent = await ids.createAgent(user.id, "Builder");
		expect(agent.name).toBe("builder");
		const issued = await ids.createToken(user.id, agent.id);
		expect(issued.token).toMatch(/^ghv_[A-Za-z0-9_-]{43}$/);
		expect(issued.expiresAt).toBe("2027-01-06T12:00:00.000Z");
		const found = await ids.tokenPrincipal(issued.token);
		expect(found).toMatchObject({ user: { handle: "ada" }, agent: { name: "builder" } });
		expect((await ids.agents(user.id))[0].tokens[0]).toMatchObject({
			prefix: issued.token.slice(4, 12),
			lastUsedAt: "2026-10-08T12:00:00.000Z",
		});
		expect(await ids.tokenPrincipal("ghv_not-a-real-token")).toBeNull();
	});

	it("stops a revoked token at once, and every token of a revoked agent", async () => {
		const { ids, user } = await signedIn();
		const agent = await ids.createAgent(user.id, "builder");
		const a = await ids.createToken(user.id, agent.id);
		const b = await ids.createToken(user.id, agent.id, null);
		await ids.revokeToken(user.id, a.id);
		expect(await ids.tokenPrincipal(a.token)).toBeNull();
		expect(await ids.tokenPrincipal(b.token)).not.toBeNull();
		await ids.revokeAgent(user.id, agent.id);
		expect(await ids.tokenPrincipal(b.token)).toBeNull();
		expect(await ids.activeAgent(agent.id)).toBeNull();
		// Made again, the agent is active, but its old tokens stay revoked.
		await ids.createAgent(user.id, "builder");
		expect(await ids.tokenPrincipal(b.token)).toBeNull();
		expect(await ids.activeAgent(agent.id)).not.toBeNull();
	});

	it("expires a token on its date", async () => {
		const { ids, user } = await signedIn();
		const agent = await ids.createAgent(user.id, "builder");
		const issued = await ids.createToken(user.id, agent.id, 1);
		clock += 2 * 86_400_000;
		expect(await ids.tokenPrincipal(issued.token)).toBeNull();
		clock = Date.parse("2026-10-08T12:00:00.000Z");
	});

	it("keeps one person's agents and tokens from another", async () => {
		const { ids, user } = await signedIn();
		await ids.invite("eve@example.com", "person:admin");
		const { user: eve } = (await ids.signIn({
			provider: "github",
			providerId: "666",
			email: "eve@example.com",
			login: "eve",
		})) as { user: { id: string } };
		const agent = await ids.createAgent(user.id, "builder");
		const issued = await ids.createToken(user.id, agent.id);
		await expect(ids.createToken(eve.id, agent.id)).rejects.toThrow(/\[404\]/);
		await expect(ids.revokeToken(eve.id, issued.id)).rejects.toThrow(/\[404\]/);
		await expect(ids.revokeAgent(eve.id, agent.id)).rejects.toThrow(/\[404\]/);
		expect(await ids.agents(eve.id)).toEqual([]);
	});

	it("refuses bad names, a duplicate, and token lifetimes out of range", async () => {
		const { ids, user } = await signedIn();
		await expect(ids.createAgent(user.id, "has/slash")).rejects.toThrow(/\[400\]/);
		await expect(ids.createAgent(user.id, "")).rejects.toThrow(/\[400\]/);
		const agent = await ids.createAgent(user.id, "builder");
		await expect(ids.createAgent(user.id, "builder")).rejects.toThrow(/\[409\]/);
		await expect(ids.createToken(user.id, agent.id, 0)).rejects.toThrow(/\[400\]/);
		await expect(ids.createToken(user.id, agent.id, 400)).rejects.toThrow(/\[400\]/);
	});
});
