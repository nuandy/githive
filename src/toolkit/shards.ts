// Sharded claims (see docs/design.md). Once the load calls for it,
// the claims are split by path into shards, each its own Git ref, so agents
// working in different parts of the tree never contend for one ref. The
// registry stays above them all, as the shard "" (see claim-store.ts). A
// claim lives in the shard of its first `depth` path segments. A claim with
// fewer segments ("wide", like docs/) lives in its own path's shard, which is
// an ancestor of every shard it covers; a claim spread over many shards, in
// the one holding all of them. So two overlapping claims are always in the
// same shard (where the ref's compare-and-swap decides) or in an ancestor and
// a descendant (where each, after writing, checks the other).

const segments = (entry: string) => entry.replace(/\/$/, "").split("/");

/** The shard a claimed path (or a changed file) belongs to. */
export const shardOf = (entry: string, depth: number) => segments(entry).slice(0, depth).join("/");

/** Whether a claimed path is shallower than the shards: it then covers every shard under its own. */
export const isWide = (entry: string, depth: number) => segments(entry).length < depth;

/** A shard's ancestors, outermost first. */
export function ancestorsOf(shard: string) {
	const parts = shard.split("/");
	return parts.slice(1).map((_, i) => parts.slice(0, i + 1).join("/"));
}

/** A shard as one ref component: every character but letters, digits, _ and - percent-encoded ("/" too). */
export const encodeShard = (shard: string) => encodeURIComponent(shard).replace(/[!'()*.~]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
export const decodeShard = (encoded: string) => decodeURIComponent(encoded);

/** Where a repo's claim shards live: one ref each, side by side, so a shard's descendants share its prefix. */
export const shardsPrefix = (repo: string) => `refs/notes/githive-claim-shards/${repo}/`;
export const shardRef = (repo: string, shard: string) => `${shardsPrefix(repo)}${encodeShard(shard)}`;

/**
 * Which of a repo's `count` records repos holds a shard: a stable hash of its
 * name. Artifacts takes one push at a time per repo; shards in different
 * records repos are written side by side.
 */
export function recordsRepoOf(shard: string, count: number) {
	let hash = 0x811c9dc5;
	for (let i = 0; i < shard.length; i++) hash = Math.imul(hash ^ shard.charCodeAt(i), 0x01000193);
	return (hash >>> 0) % count;
}

/** A records repo's name: never a change fork's (fork--<repo>--<change>), whatever an agent names its change. */
export const recordsRepoName = (repo: string, k: number) => `records--${repo}--${k}`;

/**
 * Each change's index: the shards it has claimed in, so reading one change's
 * claim needn't read every shard. Written before the shards, and only ever
 * added to, so it always covers every shard the change holds.
 */
export const changeRef = (repo: string, change: string) => `refs/notes/githive-claim-changes/${repo}/${encodeShard(change)}`;
/** Which records repo holds a change's index. */
export const changeRepoOf = (change: string, count: number) => recordsRepoOf(`change:${change}`, count);
