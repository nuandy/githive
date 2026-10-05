import type { Change } from "./model";

// Who is behind a change, shortened for people. The server records identities
// as "service:<client id>[/<name>]", "person:<hash>" or "blueprint-builder".

/** A change worked on by Blueprint's own builder rather than an outside agent. */
export function isHosted(change: Pick<Change, "external" | "openedBy">): boolean {
	if (change.openedBy === "blueprint-builder") return true;
	return change.external !== true;
}

/** A readable name for a recorded identity, or undefined when there is none. */
export function identityName(raw: string | undefined | null): string | undefined {
	const value = typeof raw === "string" ? raw.trim() : "";
	if (!value) return undefined;
	if (value === "blueprint-builder") return "Blueprint builder";
	if (value.startsWith("service:")) {
		const rest = value.slice("service:".length);
		const named = rest.split("/").filter(Boolean).pop() ?? rest;
		if (named !== rest) return named;
		return `agent ${rest.slice(0, 8)}`;
	}
	if (value.startsWith("person:")) return `person ${value.slice("person:".length).slice(0, 8)}`;
	return value;
}

/** Who a change belongs to, as the change list and page show it. */
export function agentLabel(change: Pick<Change, "external" | "openedBy" | "agent">): string {
	return change.agent?.trim() || identityName(change.openedBy) || (change.external === true ? "external agent" : "Blueprint builder");
}
