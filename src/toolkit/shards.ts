// Sharded claims (see docs/design.md). Under load, claims are split by path into shards, each its own Git ref,
// so agents in different parts of the tree don't contend for one ref. A claim lives in the shard of its first
// `depth` path segments, and a wider claim in an ancestor shard. Two overlapping claims are therefore in the same
// shard, where compare-and-swap decides, or in an ancestor and a descendant, which check each other after writing.

const segments = (entry: string) => entry.replace(/\/$/, "").split("/");

export const shardOf = (entry: string, depth: number) => segments(entry).slice(0, depth).join("/");

/** Whether a claimed path is shallower than the shards, so it covers every shard under its own. */
export const isWide = (entry: string, depth: number) => segments(entry).length < depth;

/** A shard's ancestors, outermost first. */
export function ancestorsOf(shard: string) {
	const parts = shard.split("/");
	return parts.slice(1).map((_, i) => parts.slice(0, i + 1).join("/"));
}

/** A shard as one ref component, with everything except letters, digits, _ and - percent-encoded. */
export const encodeShard = (shard: string) =>
	encodeURIComponent(shard).replace(/[!'()*.~]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
export const decodeShard = (encoded: string) => decodeURIComponent(encoded);

/** One ref per shard, side by side, so a shard's descendants share its prefix. */
export const shardsPrefix = (repo: string) => `refs/notes/githive-claim-shards/${repo}/`;
export const shardRef = (repo: string, shard: string) => `${shardsPrefix(repo)}${encodeShard(shard)}`;

/**
 * Which of a repo's `count` records repos holds a shard, by a stable hash of its name. Artifacts takes one push
 * at a time per repo, so shards in different records repos can be written in parallel.
 */
export function recordsRepoOf(shard: string, count: number) {
	let hash = 0x811c9dc5;
	for (let i = 0; i < shard.length; i++) hash = Math.imul(hash ^ shard.charCodeAt(i), 0x01000193);
	return (hash >>> 0) % count;
}

/** A records repo's name, which can't collide with a change fork's (fork--<repo>--<change>). */
export const recordsRepoName = (repo: string, index: number) => `records--${repo}--${index}`;

/**
 * A change's index of the shards it has claimed in, so reading one claim needn't read every shard. It is
 * written before the shards and only grows, so it always covers them.
 */
export const changeRef = (repo: string, change: string) =>
	`refs/notes/githive-claim-changes/${repo}/${encodeShard(change)}`;
export const changeRepoOf = (change: string, count: number) => recordsRepoOf(`change:${change}`, count);
