import type { ReviewPolicy, SavedSettings } from "../api";

// The editable Settings form of an elected repo, as plain data: what the form
// holds (strings, as typed), and the request it saves. Checks mirror the
// server's, so most mistakes show before saving; the server has the last word.

export interface EscalationDraft {
	/** Paths, one per line or comma-separated. */
	paths: string;
	/** Extra reviewer roles, comma-separated. */
	reviewers: string;
	/** Approvals needed when it applies; blank keeps the repo's number. */
	required: string;
	/** Extra roles that can block, comma-separated. */
	vetoes: string;
}

export interface SettingsDraft {
	required: string;
	reviewers: string[];
	vetoes: string[];
	external: string[];
	externalWaitMinutes: string;
	escalate: EscalationDraft[];
	verify: string[];
	leaseMinutes: string;
}

export const ROLE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const DEFAULT_LEASE_MINUTES = 30;
export const DEFAULT_EXTERNAL_WAIT_MINUTES = 60;

/** "a, b\nc" → ["a", "b", "c"] */
export function splitList(text: string): string[] {
	return text
		.split(/[\n,]/)
		.map((item) => item.trim())
		.filter(Boolean);
}

export function draftFromSettings(settings: { review: ReviewPolicy; verify: string[]; leaseMinutes?: number }): SettingsDraft {
	const { review } = settings;
	return {
		required: String(review.required ?? 0),
		reviewers: [...(review.reviewers ?? [])],
		vetoes: [...(review.vetoes ?? [])],
		external: [...(review.external ?? [])],
		externalWaitMinutes: review.externalWaitMinutes !== undefined ? String(review.externalWaitMinutes) : "",
		escalate: (review.escalate ?? []).map((e) => ({
			paths: (e.paths ?? []).join("\n"),
			reviewers: (e.reviewers ?? []).join(", "),
			required: e.required !== undefined ? String(e.required) : "",
			vetoes: (e.vetoes ?? []).join(", "),
		})),
		verify: [...(settings.verify ?? [])],
		leaseMinutes: String(settings.leaseMinutes ?? DEFAULT_LEASE_MINUTES),
	};
}

/** Every role the draft mentions: the reviewers and those its stricter path rules add. */
export function draftRoles(draft: SettingsDraft): string[] {
	const extra = draft.escalate.flatMap((e) => [...splitList(e.reviewers), ...splitList(e.vetoes)]);
	return [...new Set([...draft.reviewers, ...extra])];
}

/** Remove a reviewer role, and with it the role's block and outside-review marks. */
export function removeRole(draft: SettingsDraft, role: string): SettingsDraft {
	return {
		...draft,
		reviewers: draft.reviewers.filter((r) => r !== role),
		vetoes: draft.vetoes.filter((r) => r !== role),
		external: draft.external.filter((r) => r !== role),
	};
}

const wholeNumber = (text: string) => (/^\d+$/.test(text.trim()) ? Number(text.trim()) : NaN);

/** The settings to save, or what's wrong with the draft. */
export function settingsFromDraft(draft: SettingsDraft): { settings: SavedSettings; errors: [] } | { settings?: undefined; errors: string[] } {
	const errors: string[] = [];
	const reviewers = draft.reviewers.map((r) => r.trim()).filter(Boolean);
	const bad = reviewers.filter((r) => !ROLE.test(r));
	if (bad.length) errors.push(`Reviewer roles are lowercase words joined by hyphens: ${bad.join(", ")}`);
	if (new Set(reviewers).size !== reviewers.length) errors.push("Each reviewer role can be listed once.");

	const required = wholeNumber(draft.required);
	if (Number.isNaN(required) || required > reviewers.length) errors.push(`Required approvals must be a whole number from 0 to ${reviewers.length}.`);

	const vetoes = draft.vetoes.filter((r) => reviewers.includes(r));
	const escalate = draft.escalate.map((row, index) => {
		const paths = splitList(row.paths);
		const extra = splitList(row.reviewers);
		const extraVetoes = splitList(row.vetoes);
		if (!paths.length) errors.push(`Path rule ${index + 1} needs at least one path.`);
		const badRoles = [...extra, ...extraVetoes].filter((r) => !ROLE.test(r));
		if (badRoles.length) errors.push(`Path rule ${index + 1}: roles are lowercase words joined by hyphens: ${badRoles.join(", ")}`);
		const needs = row.required.trim() ? wholeNumber(row.required) : undefined;
		if (Number.isNaN(needs)) errors.push(`Path rule ${index + 1}: required approvals must be a whole number.`);
		return {
			paths,
			...(extra.length ? { reviewers: extra } : {}),
			...(needs !== undefined && !Number.isNaN(needs) ? { required: needs } : {}),
			...(extraVetoes.length ? { vetoes: extraVetoes } : {}),
		};
	});

	const roles = [...new Set([...reviewers, ...escalate.flatMap((e) => [...(e.reviewers ?? []), ...(e.vetoes ?? [])])])];
	const external = draft.external.filter((r) => roles.includes(r));

	let externalWaitMinutes: number | undefined;
	if (draft.externalWaitMinutes.trim()) {
		externalWaitMinutes = wholeNumber(draft.externalWaitMinutes);
		if (Number.isNaN(externalWaitMinutes) || externalWaitMinutes < 5 || externalWaitMinutes > 1440)
			errors.push("The wait for outside reviewers must be a whole number of minutes from 5 to 1440.");
	}

	const leaseMinutes = wholeNumber(draft.leaseMinutes);
	if (Number.isNaN(leaseMinutes) || leaseMinutes < 5 || leaseMinutes > 1440) errors.push("Claim expiry must be a whole number of minutes from 5 to 1440.");

	const verify = draft.verify.map((command) => command.trim()).filter(Boolean);
	if (errors.length) return { errors };
	const review: ReviewPolicy = {
		reviewers,
		required,
		vetoes,
		...(external.length ? { external } : {}),
		...(escalate.length ? { escalate } : {}),
		...(externalWaitMinutes !== undefined ? { externalWaitMinutes } : {}),
	};
	return { settings: { review, verify, leaseMinutes }, errors: [] };
}

/** One sentence describing a review policy, for the read-only summary. */
export function describePolicy(review: ReviewPolicy): string {
	const parts = [review.required ? `${review.required} ${review.required === 1 ? "approval" : "approvals"} from ${review.reviewers.join(", ") || "reviewers"}` : "No approvals needed; the checks decide"];
	if (review.vetoes.length) parts.push(`${review.vetoes.join(", ")} must approve and can block`);
	return parts.join("; ");
}
