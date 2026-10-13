// Who is behind a change or a vote, shortened for people. The server records
// identities as "service:<client id>[/<name>]", "person:<hash>" or "githive-builder".

/** A readable name for a recorded identity, or undefined when there is none. */
export function identityName(raw: string | undefined | null): string | undefined {
	const value = typeof raw === "string" ? raw.trim() : "";
	if (!value) return undefined;
	if (value === "githive-builder") return "GitHive builder";
	// A registered agent, by the name it registered.
	if (value.startsWith("agent:")) return value.slice("agent:".length);
	if (value.startsWith("service:")) {
		const rest = value.slice("service:".length);
		const named = rest.split("/").filter(Boolean).pop() ?? rest;
		if (named !== rest) return named;
		return `agent ${rest.slice(0, 8)}`;
	}
	if (value.startsWith("person:")) return `person ${value.slice("person:".length).slice(0, 8)}`;
	return value;
}

/** A name in a sentence: a recorded identity shortened, and GitHive's own flags as GitHive. */
/** Who asks a person, or whose change waits on one, as the Hive's banner and the Inbox say it: GitHive for its own. */
export function whoWaits(agent: string): string {
	return agent.startsWith("githive") ? "GitHive" : (displayName(agent) ?? agent);
}

export function displayName(raw: string | undefined | null): string | undefined {
	if (!raw) return undefined;
	if (raw === "githive") return "GitHive";
	return raw.includes(":") ? (identityName(raw) ?? raw) : raw;
}
