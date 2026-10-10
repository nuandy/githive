import type { RepoSnapshot, SettingsInput } from "../api";
import { DEFAULT_SKIP_CHECKS } from "../../../src/toolkit/check-scope";

// The Settings tab's form for how changes merge: the review policy and the
// checks, as text fields while they're edited, and back to what the settings
// tool takes.

type Policy = RepoSnapshot["policy"];

/** A role's name: lowercase words joined by hyphens, like "security" or "api-design". */
export const ROLE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** The form's fields: lists as comma- or line-separated text. */
export interface MergeDraft {
	required: string;
	/** Roles that can block any change. */
	vetoes: string;
	/** Who may vote as each role that can block: blank for the default (people and GitHive's reviewers). */
	grants: Record<string, string>;
	/** Stricter rules for chosen paths: approvals blank for the repo's own. */
	escalate: { paths: string; required: string; vetoes: string }[];
	verify: string[];
	/** What the checks skip, one pattern a line (blank: nothing, the checks always run). */
	skipChecks: string;
}

export function splitList(text: string): string[] {
	return [
		...new Set(
			text
				.split(/[\n,]/)
				.map((s) => s.trim())
				.filter(Boolean),
		),
	];
}

/** The form's fields from the settings; what the checks skip, the server's defaults when it didn't say (so a save never turns skipping off unasked). */
export function draftFrom(policy: Policy, verify: string[], skipChecks: string[] = DEFAULT_SKIP_CHECKS): MergeDraft {
	return {
		skipChecks: skipChecks.join("\n"),
		required: String(policy.required),
		vetoes: policy.vetoes.join(", "),
		grants: Object.fromEntries(
			Object.entries(policy.grants ?? {}).map(([role, holders]) => [role, holders.join(", ")]),
		),
		escalate: (policy.escalate ?? []).map((e) => ({
			paths: e.paths.join("\n"),
			required: e.required === undefined ? "" : String(e.required),
			vetoes: (e.vetoes ?? []).join(", "),
		})),
		verify: [...verify],
	};
}

/** Every role that can block a change in the draft: the repo's own, then those the path rules add. */
export function blockingRolesOf(draft: MergeDraft): string[] {
	return [...new Set([...splitList(draft.vetoes), ...draft.escalate.flatMap((e) => splitList(e.vetoes))])].filter((r) =>
		ROLE.test(r),
	);
}

const whole = (text: string) => (/^\d+$/.test(text.trim()) ? Number(text.trim()) : null);

/** What the settings tool takes, from the draft; or what's wrong with it. */
export function settingsFrom(
	draft: MergeDraft,
): { settings: SettingsInput; errors: [] } | { settings?: undefined; errors: string[] } {
	const errors: string[] = [];
	const required = whole(draft.required);
	if (required === null) errors.push("Required approvals is a whole number, 0 for none.");
	const badRole = (roles: string[]) =>
		roles
			.filter((r) => !ROLE.test(r))
			.map((r) => `"${r}" isn't a role name: use lowercase words joined by hyphens, like "security" or "api-design".`);
	const vetoes = splitList(draft.vetoes);
	errors.push(...badRole(vetoes));
	const escalate: SettingsInput["escalate"] = [];
	draft.escalate.forEach((row, i) => {
		const paths = splitList(row.paths);
		const rowVetoes = splitList(row.vetoes);
		const rowRequired = row.required.trim() ? whole(row.required) : undefined;
		if (!paths.length) errors.push(`Rule ${i + 1} names no paths.`);
		if (rowRequired === null) errors.push(`Rule ${i + 1}'s approvals is a whole number, or blank for the repo's own.`);
		errors.push(...badRole(rowVetoes));
		escalate.push({
			paths,
			...(rowRequired !== undefined && rowRequired !== null ? { required: rowRequired } : {}),
			...(rowVetoes.length ? { vetoes: rowVetoes } : {}),
		});
	});
	// Grants only for roles that can still block; a blank one is the default.
	const grants: Record<string, string[]> = {};
	for (const role of blockingRolesOf(draft)) {
		const holders = splitList(draft.grants[role] ?? "");
		if (holders.length) grants[role] = holders;
	}
	const verify = draft.verify.map((c) => c.trim()).filter(Boolean);
	const skipChecks = splitList(draft.skipChecks);
	for (const pattern of skipChecks)
		if (!/^[A-Za-z0-9._/*@+-]+$/.test(pattern))
			errors.push(`"${pattern}" isn't a pattern: a path or name, with * for any run of characters (*.md, docs/).`);
	if (errors.length) return { errors: [...new Set(errors)] };
	return { settings: { required: required!, vetoes, escalate, grants, verify, skip_checks: skipChecks }, errors: [] };
}
