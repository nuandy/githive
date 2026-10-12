import type { Registry } from "../claims";
import { HOSTED_PREFIX } from "./repo";
import { fail } from "../../errors";
import { GITHUB_AGENT, GITHUB_IDENTITY } from "../github-settings";

// Who a call acts as: an agent key or a sign-in names the agent, and an agent acts only as itself.

export const sha256 = async (text: string) => {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
};

/** The agent name a key is for, checked against the registry; keys are `<agent>.<secret>`. */
export async function keyAgent(registry: Registry | undefined, key: string) {
	const agent = key.slice(0, Math.max(0, key.lastIndexOf(".")));
	const record = agent ? registry?.agents?.[agent] : undefined;
	if (!record || record.keyHash !== (await sha256(key)))
		fail(403, "unknown agent key", "send the key `register` gave your agent, as X-GitHive-Agent-Key or agent_key");
	return agent;
}

/**
 * Throws unless the caller may act as `name`. Callers with a key or sign-in act only as themselves; hosted agents act
 * under the githive- names, but only GitHive's GitHub job, verified as `identity`, acts as githive-github.
 */
export function mayActAs(
	name: string,
	acting: string | undefined,
	registry: Registry | undefined,
	caller: { hosted?: boolean | undefined; identity?: string | undefined },
) {
	if (acting) {
		if (name !== acting) fail(403, `you act as ${acting}; you can't act as ${name}`, `name yourself: ${acting}`);
		return;
	}
	// What githive-github claims from GitHub's branch lands without review.
	if (name === GITHUB_AGENT && caller.identity !== GITHUB_IDENTITY)
		fail(403, `only GitHive's GitHub job acts as ${GITHUB_AGENT}`);
	if (caller.hosted) return;
	if (name.startsWith(HOSTED_PREFIX)) fail(403, "githive- names are GitHive's hosted agents'");
	// Names like person:… and service:… are verified identities, which an agent can't take on.
	if (name.includes(":")) fail(403, "an agent's name can't contain \":\"");
	// <handle>/<agent> names belong to signed-in agents, verified by their token.
	if (name.includes("/")) fail(403, `${name} is a signed-in agent's name: sign in to GitHive as it to act as it`);
	if (registry?.agents?.[name]) fail(403, `${name} is registered: call with its agent key`);
}
