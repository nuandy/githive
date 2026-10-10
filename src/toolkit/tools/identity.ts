import type { Registry } from "../claims";
import { HOSTED_PREFIX } from "./repo";

// Who a call acts as: an agent key or a sign-in names the agent, and an agent acts only as itself.

export const sha256 = async (text: string) => {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
};

/** The agent name a key is for, checked against the registry; keys are `<agent>.<secret>`. */
export async function keyAgent(registry: Registry | undefined, key: string) {
	const agent = key.slice(0, Math.max(0, key.lastIndexOf(".")));
	const record = agent ? registry?.agents?.[agent] : undefined;
	if (!record || record.keyHash !== (await sha256(key))) throw new Error("[403] unknown agent key");
	return agent;
}

/** Throws unless the caller may act as `name`. Callers with a key or sign-in act only as themselves. */
export function mayActAs(
	name: string,
	acting: string | undefined,
	registry: Registry | undefined,
	hosted: boolean | undefined,
) {
	if (acting) {
		if (name !== acting) throw new Error(`[403] you act as ${acting}; you can't act as ${name}`);
		return;
	}
	if (hosted) return;
	if (name.startsWith(HOSTED_PREFIX)) throw new Error("[403] githive- names are GitHive's hosted agents'");
	// Names like person:… and service:… are verified identities, which an agent can't take on.
	if (name.includes(":")) throw new Error("[403] an agent's name can't contain \":\"");
	// <handle>/<agent> names belong to signed-in agents, verified by their token.
	if (name.includes("/"))
		throw new Error(`[403] ${name} is a signed-in agent's name: sign in to GitHive as it to act as it`);
	if (registry?.agents?.[name]) throw new Error(`[403] ${name} is registered: call with its agent key`);
}
