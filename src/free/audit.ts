import { inLane } from "../open-mode";
import type { Registry } from "./claims";

// The coordinator-free audit (see docs/coordinator-free.md). Nothing stops an
// agent from breaking a convention, so this replays the records and reports
// every violation, with the commit and the agent responsible. A pure function:
// anyone can run it over the same records and get the same answer.

/** A merge into main, as its commit records it. */
export interface MergeRecord {
	commit: string;
	author: string;
	/** From the merge's Blueprint-Change trailer. */
	change?: string;
	/** From its Blueprint-Claims trailer: the registry tip the merging agent checked. */
	claimsTip?: string;
	/** Files the merge changed. */
	files: string[];
}

export interface Violation {
	commit: string;
	author: string;
	rule: string;
	detail: string;
}

export function audit(records: { registry: { tip: string; state: Registry }[]; merges: MergeRecord[] }): Violation[] {
	const violations: Violation[] = [];
	const registryAt = new Map(records.registry.map((r) => [r.tip, r.state]));
	for (const merge of records.merges) {
		const report = (rule: string, detail: string) => violations.push({ commit: merge.commit, author: merge.author, rule, detail });
		if (!merge.change || !merge.claimsTip) {
			report("undeclared", "the merge names no change or claims it checked (Blueprint-Change, Blueprint-Claims)");
			continue;
		}
		const state = registryAt.get(merge.claimsTip);
		if (!state) {
			report("unknown-claims", `${merge.claimsTip} is not in the claims registry's history`);
			continue;
		}
		const own = state?.claims.find((c) => c.change === merge.change);
		for (const file of merge.files) {
			const holder = state.claims.find((c) => c.change !== merge.change && inLane(file, c.paths));
			if (holder) report("inside-another-claim", `${file} was claimed by ${holder.change} (${holder.agent}) at ${merge.claimsTip}`);
			else if (!own || !inLane(file, own.paths)) report("outside-claim", `${file} was not in ${merge.change}'s claim at ${merge.claimsTip}`);
		}
	}
	return violations;
}
