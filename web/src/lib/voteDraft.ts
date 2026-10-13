// A vote half written, kept for the session so leaving the page and coming back finds it as it was left: per repo,
// change and commit, since a vote is on one commit. Sending the vote drops it.

export type VoteChoice = "approve" | "request" | "block";

export interface VoteDraft {
	choice?: VoteChoice | null | undefined;
	role?: string | undefined;
	evidence?: string | undefined;
}

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const CHOICES: VoteChoice[] = ["approve", "request", "block"];

export const voteDraftKey = (repo: string, change: string, head: string) => `githive:vote:${repo}:${change}:${head}`;

/** The session's storage, where there is one to use. */
export function sessionStore(): Store | undefined {
	try {
		return window.sessionStorage;
	} catch {
		return undefined;
	}
}

/** The draft kept under `key`, or nothing: what can't be read is dropped. */
export function readVoteDraft(store: Pick<Store, "getItem"> | undefined, key: string): VoteDraft {
	let kept: unknown;
	try {
		kept = JSON.parse(store?.getItem(key) ?? "null");
	} catch {
		return {};
	}
	if (!kept || typeof kept !== "object") return {};
	const { choice, role, evidence } = kept as Record<string, unknown>;
	return {
		...(CHOICES.includes(choice as VoteChoice) ? { choice: choice as VoteChoice } : {}),
		...(typeof role === "string" ? { role } : {}),
		...(typeof evidence === "string" ? { evidence } : {}),
	};
}

/** Keeps the draft under `key`; one with no verdict and no words is dropped instead. */
export function keepVoteDraft(store: Store | undefined, key: string, draft: VoteDraft) {
	try {
		if (!draft.choice && !draft.evidence?.trim()) store?.removeItem(key);
		else store?.setItem(key, JSON.stringify(draft));
	} catch {
		// Only a convenience: without storage, a draft lasts as long as the form.
	}
}
