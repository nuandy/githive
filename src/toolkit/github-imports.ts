import type { CasLog } from "../record-log";
import type { ClaimRecord, Registry } from "./claims";
import { GITHUB_AGENT, GITHUB_IDENTITY, isGitHubChange, trustsGitHub } from "./github-settings";
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
	at: string;
	by?: string;
	stamp?: string;
}

export interface GitHubImports {
	imports: GitHubImport[];
}

export const importsRef = (repo: string) => `refs/notes/githive-github/${repo}`;

const empty = (): GitHubImports => ({ imports: [] });

/** Records an import, stamped. One already recorded for the same commit and head is left as it is, and returned. */
export async function recordImport(
	log: CasLog<GitHubImports>,
	entry: Omit<GitHubImport, "at" | "by" | "stamp">,
	stamper?: Stamper,
): Promise<GitHubImport> {
	let recorded: GitHubImport | undefined;
	await appendRecord<GitHubImports, "recorded">(log, GITHUB_AGENT, empty, async (state) => {
		recorded = state.imports.find(
			(found) =>
				found.github === entry.github &&
				found.branch === entry.branch &&
				found.commit === entry.commit &&
				found.head === entry.head,
		);
		if (recorded) return { refused: "recorded" };
		const record: GitHubImport = { ...entry, at: new Date().toISOString() };
		recorded = stamper ? await stamped(record, stamper) : record;
		return {
			state: { imports: [...state.imports, recorded] },
			text:
				`GitHub's ${entry.github} ${entry.branch} at ${entry.commit.slice(0, 8)} comes in as github/${entry.branch} ` +
				`(${entry.head.slice(0, 8)}), having GitHive's work up to ${entry.base.slice(0, 8)}`,
		};
	});
	return recorded!;
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

/** Whether `head` is a commit GitHive brought in from GitHub's `branch` (an import's head). */
export const importedAt = (imports: GitHubImport[], branch: string, head: string) =>
	imports.find((entry) => entry.branch === branch && entry.head === head);

/**
 * The trust rule (see docs/github-prs.md, "The audit"), which the merge path and the audit both ask, so they never
 * disagree: whether a change lands without votes at `head`. Every record of its claim (`records`, as written, with
 * their stamps) is githive-github's with `source: github/<branch>`, stamped as service:githive-github when there's a
 * stamp key; the repo trusts GitHub's changes in `registry` (the state a merge is checked against, or the one it
 * cites); and `head` is in a stamped import of that branch, from the GitHub repo `registry` is connected to.
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
	const imported = importedAt(imports, first.source!.slice("github/".length), head);
	return !!imported && imported.github === registry!.github!.repo;
}
