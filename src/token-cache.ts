import { DurableObject } from "cloudflare:workers";
import type { Remote } from "./git";

// Artifacts tokens, kept past an isolate's life: one per project repo, for it
// and its forks and records repos. Minting a token takes several Artifacts calls (~0.6 s), and
// a fresh isolate (a deploy, a new location, a quiet spell) used to mint every
// token again; asking here costs one Durable Object call. Tokens never leave
// the Worker: they are kept here as in the isolate, and expire as they would.

export interface Kept {
	remote: Remote;
	until: number;
}

export class TokenCache extends DurableObject<Env> {
	/** The token kept for `key`, while it's still to be reused. */
	async get(key: string): Promise<Kept | null> {
		const kept = await this.ctx.storage.get<Kept>(key);
		if (kept && Date.now() < kept.until) return kept;
		if (kept) await this.ctx.storage.delete(key);
		return null;
	}

	async put(key: string, remote: Remote, until: number) {
		await this.ctx.storage.put<Kept>(key, { remote, until });
	}

	/** Forget every token: the project was deleted (a new one by its name gets its own). */
	async clear() {
		await this.ctx.storage.deleteAll();
	}
}
