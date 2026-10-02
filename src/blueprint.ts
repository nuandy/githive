import { validatePolicy } from "./quorum";
import { DEFAULT_POLICY, type Blueprint } from "./types";

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Every problem with a blueprint, in plain sentences. Empty means valid.
 * Shared by the Coordinator (which rejects) and the planner's submit tool
 * (which hands the problems back to the model to fix).
 */
export function blueprintProblems(blueprint: Blueprint): string[] {
	const problems: string[] = [];
	const { slices, contracts } = blueprint;
	if (!slices?.length) return ["A blueprint needs at least one slice."];

	for (const s of slices) {
		if (!SLUG.test(s.id) || s.id === "base") problems.push(`Slice id "${s.id}" must be a lowercase slug and not "base".`);
		if (!s.owns?.length) problems.push(`Slice ${s.id} owns no paths.`);
		for (const p of s.owns ?? [])
			if (p.startsWith("/") || p.split("/").includes("..")) problems.push(`Slice ${s.id} owns an invalid path: ${p}`);
	}
	const ids = slices.map((s) => s.id);
	for (const id of new Set(ids)) if (ids.indexOf(id) !== ids.lastIndexOf(id)) problems.push(`Slice id ${id} is used twice.`);

	// Slices may not share paths: that's what lets them build in parallel.
	for (const a of slices)
		for (const b of slices)
			for (const p of a.owns ?? [])
				for (const q of b.owns ?? [])
					if (a !== b && p.startsWith(q)) problems.push(`${a.id} owns ${p}, which overlaps ${b.id}'s ${q}.`);

	for (const path of Object.keys(contracts ?? {}))
		if (path.startsWith("/") || path.split("/").includes("..")) problems.push(`Contract path is invalid: ${path}`);

	try {
		validatePolicy(blueprint.review ?? DEFAULT_POLICY);
	} catch (err) {
		problems.push(`Review policy: ${(err as Error).message.replace(/^\[\d{3}\] /, "")}`);
	}
	return problems;
}
