import { z } from "zod";
import { fail } from "./errors";

// What a record's state must look like for GitHive to read it. Records live in Git, so anyone with the account's
// Artifacts credentials can write one with plain git; a malformed state should fail as a clear error naming the
// record, not somewhere deeper as an undefined property. The schemas check only what the code relies on and let
// any other field through, so records written by older GitHives, and fields added later, still read.

const strings = z.array(z.string());

const claim = z.looseObject({ change: z.string(), agent: z.string(), paths: strings });
const release = z.looseObject({ change: z.string(), agent: z.string() });
const claimsState = z.looseObject({ claims: z.array(claim), released: z.array(release) });

const changeIndex = z.looseObject({ shards: strings, agent: z.string().optional() });

const vote = z.looseObject({
	commit: z.string(),
	reviewer: z.string(),
	role: z.string(),
	verdict: z.enum(["approve", "reject"]),
});
const flag = z.looseObject({ change: z.string(), agent: z.string() });
const votesState = z.looseObject({ votes: z.array(vote), flags: z.array(flag).optional() });

const workItem = z.looseObject({ id: z.string(), title: z.string() });
const workState = z.looseObject({ items: z.array(workItem) });

const reviewsState = z.looseObject({
	holds: z.record(z.string(), z.record(z.string(), z.string())),
	waits: z.record(z.string(), z.looseObject({ since: z.string() })),
});

const checking = z.looseObject({
	base: z.string(),
	changes: z.array(z.looseObject({ change: z.string(), head: z.string(), agent: z.string() })),
});
const landingState = z.looseObject({
	lease: z.looseObject({ holder: z.string(), until: z.number() }).optional(),
	checking: checking.nullable(),
});

/** Each kind of record by its ref's prefix. */
const SCHEMAS: [prefix: string, schema: z.ZodType][] = [
	["refs/notes/githive-claims/", claimsState],
	["refs/notes/githive-claim-shards/", claimsState],
	["refs/notes/githive-claim-changes/", changeIndex],
	["refs/notes/githive-votes/", votesState],
	["refs/notes/githive-vote-buckets/", votesState],
	["refs/notes/githive-work/", workState],
	["refs/notes/githive-reviews/", reviewsState],
	["refs/notes/githive-landing/", landingState],
];

/**
 * A record's state as read, checked against what its kind of record must hold. A malformed one throws, naming the
 * record and the first thing wrong with it. A ref of no known kind passes as it is.
 */
export function checkedState<S>(ref: string, state: unknown): S {
	const known = SCHEMAS.find(([prefix]) => ref.startsWith(prefix));
	if (!known) return state as S;
	const checked = known[1].safeParse(state);
	if (checked.success) return state as S;
	const [issue] = checked.error.issues;
	const where = issue?.path.length ? issue.path.join(".") : "its state";
	const what = issue?.message ?? "it doesn't parse";
	fail(500, `the record at ${ref} is malformed (${where}: ${what}); fix it, or revert its last commit`);
}
