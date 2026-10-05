import type { AgentState, HistoryEntry } from "../api";
import { currentGate, type Tone } from "./changeStatus";
import { agentLabel, identityName } from "./agent";
import { humanizeText, mentionsChange } from "./humanize";
import { timeOf, type Change, type Review } from "./model";

// A change's Conversation: what happened to it, oldest first, like a pull
// request's timeline. Built from three sources:
//  - the repo's decision log in Git (GET /tasks/:id/history), when the server has it;
//  - the change record itself (reviews, waivers, the latest check run, when it opened and ended);
//  - the hosted builder's live log (pushes with their commit messages, parking, failures).
// The record is authoritative for reviews, waivers and the latest check run
// (it carries summaries, evidence and outputs); the log adds everything else.

export type TimelineKind =
	| "opened"
	| "pushed"
	| "review-requested"
	| "review"
	| "review-result"
	| "changes-requested"
	| "needs-you"
	| "waiver"
	| "checks"
	| "merged"
	| "abandoned"
	| "message"
	| "agent"
	| "note";

export interface TimelineItem {
	key: string;
	kind: TimelineKind;
	at?: string;
	tone: Tone;
	/** One line, already worded for people. */
	text: string;
	commit?: string;
	/** Where the commit can be browsed, when there is a place (the Code tab at that commit). */
	commitHref?: string;
	/** Longer text shown under the line (a review summary, a commit message, feedback). */
	body?: string;
	review?: Review;
	/** The record's latest check run, when this item is it. */
	gate?: NonNullable<Change["gate"]>;
}

/** Classify a decision-log line about a change. */
export function classifyHistory(text: string): { kind: TimelineKind; tone: Tone } {
	if (/^Change \S+ opened\b/.test(text)) return { kind: "opened", tone: "accent" };
	if (/\babandoned\b/.test(text) && /^Change /.test(text)) return { kind: "abandoned", tone: "neutral" };
	if (/\bintegrated into\b/.test(text)) return { kind: "merged", tone: "good" };
	if (/\breviewer (approved|rejected)\b/.test(text)) return { kind: "review", tone: /approved/.test(text) ? "good" : "bad" };
	if (/\bquorum waived\b/.test(text)) return { kind: "waiver", tone: "needs" };
	if (/\bquorum (approved|rejected|vetoed)\b/.test(text)) return { kind: "review-result", tone: /approved/.test(text) ? "good" : "bad" };
	if (/\bgate (passed|failed)\b/.test(text)) return { kind: "checks", tone: /passed/.test(text) ? "good" : "bad" };
	if (/\bgate\b/.test(text)) return { kind: "checks", tone: "warn" };
	if (/\bneeds a human\b/.test(text)) return { kind: "needs-you", tone: "needs" };
	if (/\bsent back\b/.test(text)) return { kind: "changes-requested", tone: "bad" };
	if (/\bready for review\b/.test(text)) return { kind: "review-requested", tone: "warn" };
	if (/\bpushed\b/.test(text)) return { kind: "pushed", tone: "neutral" };
	if (/^Message from\b/.test(text)) return { kind: "message", tone: "accent" };
	return { kind: "note", tone: "neutral" };
}

/** Builder log events worth a person's attention; the rest is tool chatter. */
const NOISY_EVENT = /^(run:|nudged:|blocked unsafe|starting container|container restarted|repository cloned|message delivered|finished$|review started|resolution event|resumed for wake event)/;

function builderItems(id: string, log: AgentState["log"] | undefined, ids: string[], branch: string): TimelineItem[] {
	return (Array.isArray(log) ? log : []).flatMap((entry, index): TimelineItem[] => {
		if (!entry || typeof entry.event !== "string" || NOISY_EVENT.test(entry.event)) return [];
		const at = entry.at || undefined;
		const pushed = /^pushed:\s*(.*)$/s.exec(entry.event);
		if (pushed) return [{ key: `builder:${index}`, kind: "pushed", at, tone: "neutral", text: "pushed a commit", body: pushed[1] || undefined }];
		const failed = /^failed:/.test(entry.event) || /^gave up/.test(entry.event);
		return [{ key: `builder:${index}`, kind: "agent", at, tone: failed ? "bad" : "neutral", text: `builder ${humanizeText(entry.event, ids, branch)}` }];
	}).map((item) => ({ ...item, key: `${id}:${item.key}` }));
}

function reviewItem(review: Review, index: number): TimelineItem {
	const approved = review.verdict === "approve";
	return {
		key: `review:${index}`,
		kind: "review",
		at: review.at,
		tone: approved ? "good" : "bad",
		// An outside agent's review names it; Blueprint's own reviewers go by their role.
		text: review.by ? `${identityName(review.by)} (${review.reviewer} reviewer) ${approved ? "approved" : "requested changes"}` : `${review.reviewer} reviewer ${approved ? "approved" : "requested changes"}`,
		commit: review.head,
		body: review.summary,
		review,
	};
}

function gateItem(gate: NonNullable<Change["gate"]>, branch: string): TimelineItem {
	const tone: Tone = gate.status === "passed" ? "good" : gate.status === "failed" ? "bad" : "warn";
	const text = {
		passed: "checks passed",
		failed: gate.result?.mergeConflict?.length ? `checks failed: conflicts with ${branch}` : "checks failed",
		queued: "checks queued",
		running: "checks started",
		waiting: "checks waiting for other changes to merge",
	}[gate.status] ?? `checks ${gate.status}`;
	return { key: "gate", kind: "checks", at: gate.at, tone, text, commit: gate.head, gate };
}

/** Items from the change record alone: what any server, old or new, can tell us. */
function recordItems(change: Change, ids: string[], branch: string): TimelineItem[] {
	const items: TimelineItem[] = [];
	const opener = identityName(change.openedBy);
	items.push({
		key: "opened",
		kind: "opened",
		at: change.openedAt,
		tone: "accent",
		text: `${opener ? `${opener} ` : ""}opened this change${change.owns.length ? `, claiming ${change.owns.join(", ")}` : ""}`,
	});
	if (change.head) {
		const files = change.touched.length;
		items.push({
			key: "head",
			kind: "pushed",
			tone: "neutral",
			text: `latest push${files ? `: ${files} ${files === 1 ? "file" : "files"} changed` : ""}`,
			commit: change.head,
		});
	}
	(Array.isArray(change.reviews) ? change.reviews : []).forEach((review, index) => {
		if (review) items.push(reviewItem(review, index));
	});
	if (change.lastFeedback && change.sentBackFor) {
		// The record doesn't say when; it follows the last verdict on that commit.
		const verdicts = (change.reviews ?? []).filter((review) => review?.head === change.sentBackFor).map((review) => review.at);
		items.push({
			key: "sent-back",
			kind: "changes-requested",
			at: verdicts.sort((a, b) => (timeOf(a) ?? 0) - (timeOf(b) ?? 0)).pop(),
			tone: "bad",
			text: `sent back to the agent${change.revisions ? ` (revision ${change.revisions})` : ""}`,
			commit: change.sentBackFor,
			body: humanizeText(change.lastFeedback, ids, branch),
		});
	}
	(change.waivers ?? []).forEach((waiver, index) => {
		if (!waiver) return;
		items.push({
			key: `waiver:${index}`,
			kind: "waiver",
			at: waiver.at,
			tone: "needs",
			text: `${identityName(waiver.by) ?? waiver.by ?? "someone"} approved it without full review`,
			commit: waiver.head,
			body: waiver.reason,
		});
	});
	const gate = currentGate(change) ?? change.gate;
	if (gate) items.push(gateItem(gate, branch));
	if (change.status === "integrated") items.push({ key: "ended", kind: "merged", at: change.endedAt, tone: "good", text: `merged into ${branch}` });
	if (change.status === "abandoned") items.push({ key: "ended", kind: "abandoned", at: change.endedAt, tone: "neutral", text: "abandoned this change" });
	return items;
}

/** Decision-log entries about this change, oldest first. */
export function historyForChange(entries: HistoryEntry[], id: string): HistoryEntry[] {
	return entries.filter((entry) => entry && typeof entry.text === "string" && mentionsChange(entry.text, id));
}

/**
 * Sort by time. An untimed "opened" sorts first and an untimed end last; any
 * other untimed item keeps its place after the item before it.
 */
function chronological(items: TimelineItem[]): TimelineItem[] {
	let previous = -Infinity;
	const keyed = items.map((item, index) => {
		const ms = timeOf(item.at);
		let sortAt: number;
		if (ms !== undefined) sortAt = previous = ms;
		else if (item.kind === "opened") sortAt = -Infinity;
		else if (item.kind === "merged" || item.kind === "abandoned") sortAt = Infinity;
		else sortAt = previous;
		return { item, sortAt, index };
	});
	return keyed.sort((a, b) => a.sortAt - b.sortAt || a.index - b.index).map(({ item }) => item);
}

export interface TimelineSources {
	/** The repo's decision log, or null when the server could not provide it. */
	history?: HistoryEntry[] | null;
	/** The hosted builder's live log for this change. */
	builderLog?: AgentState["log"];
	/** Every change id in the repo, kept intact when rewording log lines. */
	ids?: string[];
	/** The project's branch (main, master, ...). */
	branch?: string;
}

/**
 * On the change's own page a log line names who acted, not the change:
 * "add-stats pushed …" reads "docs-agent pushed …", and "add-stats merged into
 * main" reads "Merged into main".
 */
export function relabelForChange(text: string, id: string, agent: string): string {
	const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	if (new RegExp(`^${escaped} (pushed|ready for review)\\b`).test(text)) return agent + text.slice(id.length);
	const rest = text.match(new RegExp(`^(?:Change )?${escaped}:? ([\\s\\S]*)$`));
	return rest ? rest[1].charAt(0).toUpperCase() + rest[1].slice(1) : text;
}

export function buildTimeline(change: Change, sources: TimelineSources = {}): TimelineItem[] {
	const ids = sources.ids ?? [change.id];
	const branch = sources.branch ?? "main";
	const record = recordItems(change, ids, branch);
	const builder = builderItems(change.id, sources.builderLog, ids, branch);
	const history = sources.history ? historyForChange(sources.history, change.id) : null;

	if (!history || history.length === 0) {
		// No log: the record, with the builder's own account of its pushes.
		const hasBuilderPushes = builder.some((item) => item.kind === "pushed");
		return chronological([...record.filter((item) => !(hasBuilderPushes && item.key === "head")), ...builder]);
	}

	const gate = change.gate;
	const fromLog: TimelineItem[] = [];
	history.forEach((entry, index) => {
		const { kind, tone } = classifyHistory(entry.text);
		// The record carries these in full (summaries, evidence, reasons, outputs).
		if (kind === "review" || kind === "waiver") return;
		if (kind === "checks" && gate && entry.commit === gate.head && /\bgate (passed|failed)\b/.test(entry.text)) return;
		const text = humanizeText(entry.text, ids, branch);
		// "x sent back to its builder (revision n):\n<feedback>": the first line reads as the event, the rest as its body.
		const [headline, ...rest] = text.split("\n");
		fromLog.push({
			key: `log:${index}`,
			kind,
			at: entry.at,
			tone,
			text: relabelForChange(headline, change.id, agentLabel(change)),
			body: rest.join("\n").trim() || undefined,
			commit: entry.commit || undefined,
		});
	});

	const logKinds = new Set(fromLog.map((item) => item.kind));
	const kept = record.filter((item) => {
		if (item.key === "head") return false; // the log has every push
		if (item.key === "sent-back") return !logKinds.has("changes-requested");
		if (item.kind === "opened" || item.kind === "merged" || item.kind === "abandoned") return !logKinds.has(item.kind);
		return true;
	});

	// Pair the builder's pushes (with commit messages) with the log's pushes (with commit ids).
	const used = new Set<string>();
	for (const item of fromLog) {
		if (item.kind !== "pushed") continue;
		const at = timeOf(item.at);
		if (at === undefined) continue;
		const match = builder.find((b) => {
			const bAt = timeOf(b.at);
			return b.kind === "pushed" && !used.has(b.key) && bAt !== undefined && bAt <= at + 30_000 && bAt >= at - 120_000;
		});
		if (match) {
			used.add(match.key);
			item.body = match.body;
		}
	}
	const extraBuilder = builder.filter((item) => !used.has(item.key));
	return chronological([...kept, ...fromLog, ...extraBuilder]);
}
