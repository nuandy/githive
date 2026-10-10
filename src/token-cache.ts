import { DurableObject } from "cloudflare:workers";
import type { Remote } from "./git";

// Caches Artifacts tokens beyond an isolate's lifetime, one per project repo, covering its forks and records
// repos. Minting a token takes several Artifacts calls, which every fresh isolate would otherwise repeat.
// Tokens never leave the Worker and expire here as they would in the isolate.

export interface Kept {
	remote: Remote;
	until: number;
}

export class TokenCache extends DurableObject<Env> {
	/** The cached token for `key`, if it hasn't expired. */
	async get(key: string): Promise<Kept | null> {
		const kept = await this.ctx.storage.get<Kept>(key);
		if (kept && Date.now() < kept.until) return kept;
		if (kept) await this.ctx.storage.delete(key);
		return null;
	}

	async put(key: string, remote: Remote, until: number) {
		await this.ctx.storage.put<Kept>(key, { remote, until });
	}

	/** Forgets every token when the project is deleted, so a new project with the same name gets its own. */
	async clear() {
		await this.ctx.storage.deleteAll();
	}
}
