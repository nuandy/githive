import type { FreeSnapshot, Task } from "../api";
import { agentLabel } from "./agent";
import { conflictsByChange } from "./conflicts";
import { claimAgent, claimTitle } from "./freeStatus";
import { changesOf, isActive } from "./model";
import { href, type RepoBase } from "./routes";
import { normalizePath } from "./tree";

// The Claims map: which open change holds which part of a repo. A claim on a
// folder ("src/stats/") holds everything under it; a claim on a file holds that
// file. Changes are told apart by color (one of a fixed set, in order).

export const CLAIM_COLORS = 8;

export interface ClaimHolder {
	change: string;
	title: string;
	agent: string;
	/** Claimed paths (and, in elected repos, files it has changed). */
	paths: string[];
	href: string;
	/** 0-based index into the claim colors. */
	color: number;
	/** Files where it conflicts with another open change or the project's branch. */
	conflicts: string[];
}

export function holdersFromTask(task: Pick<Task, "slices" | "checks">, repo: string, base: RepoBase = "repos"): ClaimHolder[] {
	const conflicts = conflictsByChange(task);
	return changesOf(task)
		.filter(isActive)
		.map((change, index) => ({
			change: change.id,
			title: change.title || change.id,
			agent: agentLabel(change),
			paths: [...new Set([...(change.owns ?? []), ...(change.touched ?? [])])],
			href: href.change(repo, change.id, "conversation", base),
			color: index % CLAIM_COLORS,
			conflicts: [...new Set((conflicts.get(change.id) ?? []).flatMap((c) => c.files))],
		}));
}

export function holdersFromSnapshot(snapshot: Pick<FreeSnapshot, "claims">, repo: string, base: RepoBase = "free"): ClaimHolder[] {
	return snapshot.claims.map((claim, index) => ({
		change: claim.change,
		title: claimTitle(claim),
		agent: claimAgent(claim),
		paths: [...claim.paths],
		href: href.change(repo, claim.change, "conversation", base),
		color: index % CLAIM_COLORS,
		conflicts: [],
	}));
}

/** Whether a claimed path covers `path` (a file, or a folder given without a trailing slash). */
export function covers(claimed: string, path: string): boolean {
	const claim = normalizePath(claimed);
	const target = normalizePath(path);
	if (!claim) return true;
	return target === claim || target.startsWith(`${claim}/`);
}

/** The change holding a path: the one with the most specific claim on it. */
export function holderOf(path: string, holders: ClaimHolder[]): ClaimHolder | undefined {
	let best: ClaimHolder | undefined;
	let bestLength = -1;
	for (const holder of holders) {
		for (const claimed of holder.paths) {
			const length = normalizePath(claimed).length;
			if (covers(claimed, path) && length > bestLength) {
				best = holder;
				bestLength = length;
			}
		}
	}
	return best;
}

/** Whether any change claims something inside a folder (so the map opens it). */
export function holdsInside(dir: string, holders: ClaimHolder[]): boolean {
	return holders.some((holder) => holder.paths.some((claimed) => covers(dir, claimed) || covers(claimed, dir)));
}

/** Claimed paths that aren't in the listing yet: new files, or folders a change will create. */
export function claimedElsewhere(files: string[], holders: ClaimHolder[]): { path: string; holder: ClaimHolder }[] {
	const out: { path: string; holder: ClaimHolder }[] = [];
	for (const holder of holders) {
		for (const claimed of holder.paths) {
			const clean = normalizePath(claimed);
			if (!clean) continue;
			if (files.some((file) => covers(clean, file))) continue;
			out.push({ path: claimed, holder });
		}
	}
	return out.sort((a, b) => a.path.localeCompare(b.path));
}
