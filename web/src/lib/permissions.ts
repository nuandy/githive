// What a person may do in a repo, as the server says (GET .../access), and
// what the dashboard offers them because of it. The server checks every
// action itself; these only hide what would be refused.

export type Level = "read" | "review" | "write" | "admin";

export const LEVELS: Level[] = ["read", "review", "write", "admin"];
const RANK: Record<Level, number> = { read: 1, review: 2, write: 3, admin: 4 };

export const atLeast = (level: Level | null | undefined, needed: Level) => !!level && RANK[level] >= RANK[needed];

/** What each level lets a person do, in words. */
export const LEVEL_WORDS: Record<Level, string> = {
	read: "Read: see the repo, its changes and its code",
	review: "Review: read, and vote on changes",
	write: "Write: review, and claim, push and land changes",
	admin: "Admin: write, and change settings, collaborators, and delete the repo",
};

/** Voting on a change from the dashboard needs review. */
export const canVote = (level: Level | null | undefined) => atLeast(level, "review");
/** A repo's settings (visibility, collaborators, deleting) need admin. */
export const canAdminister = (level: Level | null | undefined) => atLeast(level, "admin");
/** Making a branch, or merging a change, from the dashboard needs write. */
export const canWrite = (level: Level | null | undefined) => atLeast(level, "write");
