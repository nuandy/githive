import type { CasLog } from "../record-log";
import { GitCasLog } from "../record-log";
import type { Remote } from "../git";
import { readAllShards, readRefs } from "./record-refs";
import { recordsRepoOf } from "./shards";
import type { Stamper } from "./stamp";
import { type FlagRecord, flagChange, type VoteRecord, type Votes, vote } from "./votes";

// Where a repo's votes live: in its votes record until load calls for more (see votesShardingReason), then also
// in per-commit buckets, each its own ref, so reviewers voting on different commits don't contend. Votes never
// conflict, so the switch needs no coordination; readers read the record along with the buckets they need.
// Flags (questions for a person) are rare and always stay in the record.

/** How many buckets the votes are split into when they shard. */
export const VOTE_BUCKETS = 16;

export const bucketOf = (commit: string, buckets: number) =>
	String((Number.parseInt(commit.slice(0, 6), 16) || 0) % buckets);

export const votesPrefix = (repo: string) => `refs/notes/githive-vote-buckets/${repo}/`;
const bucketRef = (repo: string, bucket: string) => `${votesPrefix(repo)}${bucket}`;

export interface VotesView {
	votes: VoteRecord[];
	flags: FlagRecord[];
	/** The tip read for each record, keyed "" for the votes record or else by bucket. A merge cites these. */
	tips: Map<string, string>;
	/** The bucket count when read, or 0 if not sharded. */
	buckets: number;
	sharded?: { since?: string; because?: string };
}

export interface VoteStore {
	read(): Promise<VotesView>;
	/** The flags and the votes on these commits, plus any others in the records read. */
	readFor(commits: string[]): Promise<VotesView>;
	vote(input: Omit<VoteRecord, "at" | "by" | "stamp">, stamper?: Stamper): Promise<unknown>;
	flag(input: Omit<FlagRecord, "at" | "by" | "stamp">, stamper?: Stamper): Promise<unknown>;
	/** The GitHive-Votes trailer for a merge of `commit`, from the view its votes were counted in. */
	cite(view: VotesView, commit: string): string;
}

export interface VoteStoreInput {
	repo: string;
	/** The votes record's log, and its head if the caller has just read it. */
	root: CasLog<Votes>;
	rootHead?: Awaited<ReturnType<CasLog<Votes>["read"]>>;
	remote: () => Promise<Remote>;
	/** Credentials for a records repo, when the buckets are spread over records repos. */
	recordsRemote?: (k: number) => Promise<Remote>;
}

type Entry = { bucket: string; tip: string; state: Votes };
const ROOT = "";

export function voteStore(input: VoteStoreInput): VoteStore {
	return new BucketedVotes(input);
}

class BucketedVotes implements VoteStore {
	private readonly logs = new Map<string, CasLog<Votes>>();
	private buckets = 0;
	private recordsRepos = 0;
	private sharded?: { since?: string; because?: string };
	private known?: Awaited<ReturnType<CasLog<Votes>["read"]>>;

	constructor(private readonly input: VoteStoreInput) {
		this.known = input.rootHead;
		this.learn(input.rootHead?.commit.state);
	}

	// Sharding only ever turns on, so the first sharded state seen is final.
	private learn(state: Votes | null | undefined) {
		if (!state?.buckets || this.buckets) return;
		this.buckets = state.buckets;
		this.recordsRepos = state.recordsRepos ?? 0;
		this.sharded = { since: state.shardedAt, because: state.shardedBecause };
	}

	private get spread() {
		return this.input.recordsRemote ? this.recordsRepos : 0;
	}

	// -1 is the project repo, otherwise a records repo index.
	private repoOf(bucket: string) {
		return this.spread ? recordsRepoOf(`votes:${bucket}`, this.spread) : -1;
	}

	private remote(k: number) {
		return k < 0 ? this.input.remote() : this.input.recordsRemote!(k);
	}

	private logOf(bucket: string) {
		let log = this.logs.get(bucket);
		if (!log)
			this.logs.set(
				bucket,
				(log = new GitCasLog<Votes>(
					() => this.remote(this.repoOf(bucket)),
					this.input.repo,
					bucketRef(this.input.repo, bucket),
				)),
			);
		return log;
	}

	// Uses the head the caller just read once, then reads the ref again.
	private async readRoot(): Promise<Entry[]> {
		const head = this.known !== undefined ? this.known : await this.input.root.read();
		this.known = undefined;
		this.learn(head?.commit.state);
		return head ? [{ bucket: ROOT, tip: head.tip, state: head.commit.state }] : [];
	}

	private async readAll(): Promise<Entry[]> {
		const prefix = votesPrefix(this.input.repo);
		const repos = this.spread ? Array.from({ length: this.spread }, (_, k) => k) : [-1];
		const read = await Promise.all(repos.map(async (k) => readAllShards<Votes>(await this.remote(k), prefix)));
		return read.flat().map((e) => ({ bucket: e.ref.slice(prefix.length), tip: e.tip, state: e.state }));
	}

	private async readBuckets(buckets: string[]): Promise<Entry[]> {
		const byRepo = new Map<number, string[]>();
		for (const bucket of new Set(buckets))
			byRepo.set(this.repoOf(bucket), [...(byRepo.get(this.repoOf(bucket)) ?? []), bucket]);
		const prefix = votesPrefix(this.input.repo);
		const read = await Promise.all(
			[...byRepo].map(async ([k, group]) =>
				readRefs<Votes>(
					await this.remote(k),
					group.map((b) => bucketRef(this.input.repo, b)),
				),
			),
		);
		return read.flat().map((e) => ({ bucket: e.ref.slice(prefix.length), tip: e.tip, state: e.state }));
	}

	private viewOf(entries: Entry[]): VotesView {
		return {
			// Oldest first across all records read, as if they were one.
			votes: entries.flatMap((e) => e.state.votes).sort((a, b) => a.at.localeCompare(b.at)),
			flags: entries.flatMap((e) => e.state.flags ?? []),
			tips: new Map(entries.map((e) => [e.bucket, e.tip])),
			buckets: this.buckets,
			...(this.sharded ? { sharded: this.sharded } : {}),
		};
	}

	async read() {
		const root = await this.readRoot();
		return this.viewOf([...root, ...(this.buckets ? await this.readAll() : [])]);
	}

	async readFor(commits: string[]) {
		const root = await this.readRoot();
		return this.viewOf([
			...root,
			...(this.buckets && commits.length ? await this.readBuckets(commits.map((c) => bucketOf(c, this.buckets))) : []),
		]);
	}

	async vote(input: Omit<VoteRecord, "at" | "by" | "stamp">, stamper?: Stamper) {
		await this.readRoot();
		return vote(this.buckets ? this.logOf(bucketOf(input.commit, this.buckets)) : this.input.root, input, stamper);
	}

	flag(input: Omit<FlagRecord, "at" | "by" | "stamp">, stamper?: Stamper) {
		return flagChange(this.input.root, input, stamper);
	}

	// Unsharded: the record's tip. Sharded: `=tip` for the record, plus `bucket=tip` for the commit's bucket if any.
	cite(view: VotesView, commit: string) {
		if (!view.buckets) return view.tips.get(ROOT) ?? "";
		const bucket = bucketOf(commit, view.buckets);
		return [
			`=${view.tips.get(ROOT) ?? ""}`,
			...(view.tips.has(bucket) ? [`${bucket}=${view.tips.get(bucket)}`] : []),
		].join(" ");
	}
}
