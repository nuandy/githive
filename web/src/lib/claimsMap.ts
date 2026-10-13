import type { RepoLanding, RepoSnapshot } from "../api";
import { openOn } from "./changeList";
import { claimAgent, claimTitle } from "./claimStatus";
import { LAMPS, type Lamp } from "./overview";
import { href } from "./routes";
import { changeState } from "./status";
import { normalizePath } from "./tree";

// The Claims map: which open change holds which part of a branch. A claim on a folder ("src/stats/") holds everything
// under it; a claim on a file holds that file. Each change shows in its state (status.ts), its color, pattern and
// glyph, as everywhere: the map tells what's held and where its change is, and names who holds it.

export interface ClaimHolder {
	change: string;
	title: string;
	agent: string;
	/** Claimed paths. */
	paths: string[];
	href: string;
	/** Where its change is: the color, pattern and glyph its rows take. */
	state: Lamp;
	/** Files conflicting with another open change or the project's branch. None are known, since claims keep none. */
	conflicts: string[];
}

/**
 * The open changes' claims, each with where its change is: on `branch` alone when given (a claim holds its paths on
 * the branch it lands on, and nowhere else), else on every branch. `landing` is the batch being checked; `now` tells
 * an abandoned change.
 */
export function holdersFromSnapshot(
	snapshot: Pick<RepoSnapshot, "claims" | "votes" | "policy" | "branch">,
	repo: string,
	{ branch, landing, now }: { branch?: string; landing?: Pick<RepoLanding, "checking">; now?: number } = {},
): ClaimHolder[] {
	const claims = branch ? openOn(snapshot, branch) : snapshot.claims;
	const context = { votes: snapshot.votes, policy: snapshot.policy, landing, now: now ?? Date.now() };
	return claims.map((claim) => ({
		change: claim.change,
		title: claimTitle(claim),
		agent: claimAgent(claim),
		paths: [...claim.paths],
		href: href.change(repo, claim.change),
		state: changeState(claim, context),
		conflicts: [],
	}));
}

/** The other branches open changes land on, with how many each. */
export function claimsOnOtherBranches(
	snapshot: Pick<RepoSnapshot, "claims" | "branch">,
	branch: string,
): { branch: string; count: number }[] {
	const project = snapshot.branch ?? "main";
	const counts = new Map<string, number>();
	for (const claim of snapshot.claims) {
		const into = claim.into ?? project;
		if (into !== branch) counts.set(into, (counts.get(into) ?? 0) + 1);
	}
	return [...counts].sort(([a], [b]) => a.localeCompare(b)).map(([name, count]) => ({ branch: name, count }));
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

/** The files some change holds, in the listing's order: what the map shows with "Only claimed". */
export function claimedFiles(files: string[], holders: ClaimHolder[]): string[] {
	return files.filter((file) => holderOf(file, holders));
}

/** How many files under a folder some change holds. */
export function heldIn(dir: string, files: string[], holders: ClaimHolder[]): number {
	return claimedFiles(
		files.filter((file) => covers(dir, file)),
		holders,
	).length;
}

/** How many changes are in each state, the most urgent first, leaving out the states none is in: the map's key. */
export function stateCounts(holders: ClaimHolder[]): [Lamp, number][] {
	return LAMPS.map((lamp): [Lamp, number] => [lamp, holders.filter((holder) => holder.state === lamp).length]).filter(
		([, count]) => count > 0,
	);
}

/** Claimed paths that aren't in the listing yet: new files, or folders a change will create. */
export function claimedElsewhere(files: string[], holders: ClaimHolder[]): { path: string; holder: ClaimHolder }[] {
	const elsewhere: { path: string; holder: ClaimHolder }[] = [];
	for (const holder of holders) {
		for (const claimed of holder.paths) {
			const clean = normalizePath(claimed);
			if (!clean) continue;
			if (files.some((file) => covers(clean, file))) continue;
			elsewhere.push({ path: claimed, holder });
		}
	}
	return elsewhere.sort((a, b) => a.path.localeCompare(b.path));
}
