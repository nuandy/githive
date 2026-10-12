import { beforeAll, describe, expect, it } from "vitest";
import { audit, type AuditRecords, mergeStampPayload, type MergeRecord } from "../src/toolkit/audit";
import type { ClaimRecord, Registry } from "../src/toolkit/claims";
import type { GitHubImport } from "../src/toolkit/github-imports";
import { GITHUB_AGENT, GITHUB_IDENTITY, githubChangeId, type GitHubSettings } from "../src/toolkit/github-settings";
import { generateStampKey, makeStamper, type Stamper, stampPayload } from "../src/toolkit/stamp";

// The audit accepts a merge with no votes, where the policy needs them, only
// when all of these hold: githive-github claimed it (stamped as it) with
// source github/<branch>, its head is a commit the import record holds
// (stamped), and the repo trusted GitHub's changes, connected to that GitHub
// repo, in the registry state it cites. Anything else that skips a vote is
// reported as before.

let key: { privateKey: string; publicKey: string };
let as: { github: Stamper; someone: Stamper };
const head = "h".repeat(40);
const policy = { required: 1, vetoes: [] };
const link: GitHubSettings = { repo: "acme/shop", sync: "pr", trust: true };
/** The change githive-github makes for the import of commit c…c. */
const CHANGE = githubChangeId("c".repeat(40));

async function stamped<T extends object>(kind: string, stamper: Stamper, record: T) {
	const withBy = { ...record, by: stamper.by };
	return { ...withBy, stamp: await stamper.stamp(stampPayload(kind, withBy)) };
}

/** GitHub's change claimed and merged without votes; `change` alters any part of the story. */
async function story(change: {
	claimBy?: Stamper;
	agent?: string;
	source?: string;
	/** Null: not connected. */
	github?: GitHubSettings | null;
	imported?: Partial<GitHubImport>;
	importBy?: Stamper | null;
	/** Another record of the same claim (a claim spread over shards), stamped by this. */
	alsoBy?: Stamper;
	/** The change's name, when not the one made for its import. */
	named?: string;
	/** A newer import of the branch, recorded at this time (the claim was made at 10:05). */
	newerAt?: string;
}) {
	const named = change.named ?? CHANGE;
	const claim = await stamped<ClaimRecord>("claim", change.claimBy ?? as.github, {
		change: named,
		agent: change.agent ?? GITHUB_AGENT,
		paths: ["docs/"],
		intent: "Bring in GitHub's changes",
		since: "2026-10-11T10:05:00.000Z",
		active: "2026-10-11T10:05:00.000Z",
		source: change.source ?? "github/main",
	});
	const github = change.github === undefined ? link : change.github;
	const start: Registry = {
		claims: [],
		released: [],
		baseline: "b0",
		policy,
		stampKey: key.publicKey,
		...(github ? { github } : {}),
	};
	const { by: _by, stamp: _stamp, ...unstampedClaim } = claim;
	const also = change.alsoBy ? [await stamped("claim", change.alsoBy, { ...unstampedClaim, paths: ["src/"] })] : [];
	const registry = [
		{ tip: "r0", state: start },
		{ tip: "r1", state: { ...start, claims: [claim, ...also] } },
	];
	const entry = {
		github: "acme/shop",
		branch: "main",
		commit: "c".repeat(40),
		head,
		base: "b0",
		at: "2026-10-11T10:00:00.000Z",
		...change.imported,
	};
	const imports = [
		change.importBy === null ? entry : await stamped("github-import", change.importBy ?? as.github, entry),
	];
	if (change.newerAt) {
		const newer = { ...entry, commit: "d".repeat(40), head: "e".repeat(40), at: change.newerAt };
		imports.push(await stamped("github-import", as.github, newer));
	}
	const unstamped: MergeRecord = {
		commit: "m1",
		author: claim.agent,
		change: named,
		claimsTip: "r1",
		head,
		base: "b0",
		files: ["docs/notes.md"],
		by: as.github.by,
	};
	const merge = { ...unstamped, stamp: await as.github.stamp(mergeStampPayload(unstamped)) };
	const records: AuditRecords = { registry, votes: [], policy, merges: [merge], imports };
	return audit(records);
}

beforeAll(async () => {
	key = await generateStampKey();
	as = {
		github: await makeStamper(key.privateKey, GITHUB_IDENTITY),
		someone: await makeStamper(key.privateKey, "service:someone"),
	};
});

describe("auditing GitHub's changes", () => {
	it("accepts a trusted GitHub change that landed without votes", async () => {
		expect(await story({})).toEqual([]);
		// Its claim spread over two records, both githive-github's.
		expect(await story({ alsoBy: as.github })).toEqual([]);
		// GitHub's branch moved on after it was claimed: it was still the newest import then.
		expect(await story({ newerAt: "2026-10-11T10:10:00.000Z" })).toEqual([]);
	});

	it.each([
		["its head isn't in the import record", () => ({ imported: { head: "x".repeat(40) } })],
		["its import isn't stamped", () => ({ importBy: null })],
		["the import came from another GitHub repo", () => ({ imported: { github: "acme/other" } })],
		["the repo didn't trust GitHub's changes then", () => ({ github: { ...link, trust: false } })],
		["the repo wasn't connected to GitHub", () => ({ github: null })],
		["another identity claimed it as githive-github", () => ({ claimBy: as.someone })],
		["another identity wrote one of its claim's records", () => ({ alsoBy: as.someone })],
		["another agent claimed it", () => ({ agent: "agent-a" })],
		["its claim merges no GitHub branch", () => ({ source: "feature/x" })],
		["its import found it needed review", () => ({ imported: { untrusted: "GitHive can't tell what GitHub took" } })],
		["it isn't named for the import it brings in", () => ({ named: "github-dddddddddddd" })],
		[
			"a newer import of the branch was recorded before it was claimed",
			() => ({ newerAt: "2026-10-11T10:01:00.000Z" }),
		],
	] as [string, () => Parameters<typeof story>[0]][])("reports the votes it lacks when %s", async (_why, change) => {
		const violations = await story(change());
		expect(violations.map((violation) => violation.rule)).toContain("undeclared");
	});
});
