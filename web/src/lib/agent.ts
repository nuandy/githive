// Who is behind a change or a vote, shortened for people. The server records
// identities as "service:<client id>[/<name>]", "person:<hash>" or "blueprint-builder".

/** A readable name for a recorded identity, or undefined when there is none. */
export function identityName(raw: string | undefined | null): string | undefined {
	const value = typeof raw === "string" ? raw.trim() : "";
	if (!value) return undefined;
	if (value === "blueprint-builder") return "Blueprint builder";
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
