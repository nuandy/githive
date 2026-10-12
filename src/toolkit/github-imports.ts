import type { CasLog } from "../record-log";
import type { ClaimRecord, Registry } from "./claims";
import { GITHUB_AGENT, GITHUB_IDENTITY, githubChangeId, isGitHubChange, trustsGitHub } from "./github-settings";
import { appendRecord } from "./records";
import { type Stamper, stampPayload, verifyStamp } from "./stamp";

// The import record (see docs/github-prs.md): each commit of GitHub's that GitHive brought in as github/<branch>, to
// merge as githive-github's change. The audit accepts that change's merge without votes only when its head is here,
// so it's stamped like every record, and appended by compare-and-swap.

export interface GitHubImport {
	/** GitHub's repo, owner/name. */
	github: string;
	/** GitHub's branch. */
	branch: string;
	/** GitHub's commit. */
	commit: string;
	/** github/<branch> in the project: GitHub's commit, or GitHive's commit joining it to `base` (see gate-github.ts). */
	head: string;
	/** The newest commit of GitHive's main whose work GitHub's branch had. */
	base: string;
	/** Why it needs review even while the repo trusts GitHub's changes (see gate-github.ts). */
	untrusted?: string;
	at: string;
	by?: string;
	stamp?: string;
}

export interface GitHubImports {
	imports: GitHubImport[];
}

export const importsRef = (repo: string) => `refs/notes/githive-github/${repo}`;

const empty = (): GitHubImports => ({ imports: [] });

/**
 * Records an import, stamped. When the branch's newest import is this one already (a step tried again), it's left as
 * it is, and returned.
 */
export async function recordImport(
	log: CasLog<GitHubImports>,
	entry: Omit<GitHubImport, "at" | "by" | "stamp">,
	stamper?: Stamper,
): Promise<GitHubImport> {
	let recorded: GitHubImport | undefined;
	await appendRecord<GitHubImports, "recorded">(log, GITHUB_AGENT, empty, async (state) => {
		// Only the newest counts (see newestImport): a GitHub branch gone back to an older commit is recorded again.
		const newest = state.imports.findLast((found) => found.branch === entry.branch);
		if (newest && sameImport(newest, entry)) {
			recorded = newest;
			return { refused: "recorded" };
		}
		const record: GitHubImport = { ...entry, at: new Date().toISOString() };
		recorded = stamper ? await stamped(record, stamper) : record;
		return {
			state: { imports: [...state.imports, recorded] },
			text:
				`GitHub's ${entry.github} ${entry.branch} at ${entry.commit.slice(0, 8)} comes in as github/${entry.branch} ` +
				`(${entry.head.slice(0, 8)}), having GitHive's work up to ${entry.base.slice(0, 8)}` +
				(entry.untrusted ? `; it needs review: ${entry.untrusted}` : ""),
		};
	});
	return recorded!;
}

function sameImport(recorded: GitHubImport, entry: Pick<GitHubImport, "github" | "commit" | "head">) {
	if (recorded.github !== entry.github) return false;
	if (recorded.commit !== entry.commit) return false;
	return recorded.head === entry.head;
}

async function stamped(record: GitHubImport, stamper: Stamper): Promise<GitHubImport> {
	const withBy = { ...record, by: stamper.by };
	return { ...withBy, stamp: await stamper.stamp(stampPayload("github-import", withBy)) };
}

/** The imports that count: all of them without a stamp key, else only those GitHive stamped. */
export async function verifiedImports(imports: GitHubImport[], stampKey: string | undefined) {
	if (!stampKey) return imports;
	const valid = await Promise.all(
		imports.map((entry) => verifyStamp(stampKey, stampPayload("github-import", entry), entry.stamp)),
	);
	return imports.filter((_, index) => valid[index]);
}

/**
 * The import a claim of GitHub's `branch` brings in: the branch's newest recorded by `claimedAt`, the claim's last
 * claim or extension. An older one was superseded or given up, so a claim made later can't bring it in.
 */
export const newestImport = (imports: GitHubImport[], branch: string, claimedAt: string) =>
	imports.findLast((entry) => entry.branch === branch && entry.at <= claimedAt);

/**
 * The trust rule (see docs/github-prs.md, "The audit"), which the merge path and the audit both ask, so they never
 * disagree: whether a change lands without votes at `head`. Every record of its claim (`records`, as written, with
 * their stamps) is githive-github's with `source: github/<branch>`, stamped as service:githive-github when there's a
 * stamp key; the repo trusts GitHub's changes in `registry` (the state a merge is checked against, or the one it
 * cites); and `head` is the head of the branch's newest stamped import when it was claimed, the import the change is
 * named for, from the GitHub repo `registry` is connected to, that found no reason to need review.
 */
export async function trustedGitHubChange(rule: {
	records: ClaimRecord[];
	head: string | undefined;
	registry: Pick<Registry, "github"> | null | undefined;
	/** The import record's entries, read only when everything else holds. */
	imports: () => Promise<GitHubImport[]>;
	stampKey: string | undefined;
}): Promise<boolean> {
	const { records, head, registry, stampKey } = rule;
	const [first] = records;
	if (!first || !head || !trustsGitHub(registry)) return false;
	if (!records.every((record) => isGitHubChange(record) && record.source === first.source)) return false;
	const stamped = async (record: ClaimRecord) =>
		record.by === GITHUB_IDENTITY && (await verifyStamp(stampKey!, stampPayload("claim", record), record.stamp));
	if (stampKey && !(await Promise.all(records.map(stamped))).every(Boolean)) return false;
	const imports = await verifiedImports(await rule.imports(), stampKey);
	const claimedAt = records.map((record) => record.active).reduce((latest, at) => (at > latest ? at : latest));
	const imported = newestImport(imports, first.source!.slice("github/".length), claimedAt);
	if (!imported || imported.head !== head) return false;
	if (first.change !== githubChangeId(imported.commit)) return false;
	if (imported.github !== registry!.github!.repo) return false;
	return !imported.untrusted;
}
