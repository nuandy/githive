import { repoTag } from "../../src/clef";
import type { WorkerUse } from "./analytics";

// One person's share of what the Worker used: their repos' Durable Objects, found by name (every object GitHive
// makes is named for its repo: `repo:<id>`, `agent:<id>:<agent>`, `record:<id>:...`, or the id alone), and their
// repos' Clef calls, found by tag. The Worker's own requests and CPU, and what its objects store, aren't reported per
// repo, so each person gets a share of them in proportion to their objects' requests, marked as an estimate.

/**
 * Cloudflare's list prices on the Workers Paid plan, in US dollars, before the monthly allowances
 * (developers.cloudflare.com: workers/platform/pricing, durable-objects/platform/pricing, workers-ai/platform/pricing).
 */
export const PRICES = {
	workerRequestsPerMillion: 0.3,
	cpuPerMillionMs: 0.02,
	objectRequestsPerMillion: 0.15,
	/** Duration is billed on 128 MB, so each second active is 0.125 GB-s. */
	gbSecondsPerMillion: 12.5,
	rowsReadPerMillion: 0.001,
	rowsWrittenPerMillion: 1.0,
	storedGbMonth: 0.2,
	neuronsPerThousand: 0.011,
};

const GB_PER_ACTIVE_SECOND = 0.125;
export const MONTH_MS = 30 * 24 * 3_600_000;

export interface RepoUse {
	repo: string;
	objectRequests: number;
	activeSeconds: number;
	rowsRead: number;
	rowsWritten: number;
	clefNeurons: number;
	/** At list prices, in US dollars. */
	cost: number;
}

export interface OwnUsage {
	from: string;
	to: string;
	repos: RepoUse[];
	/**
	 * The priced part of what isn't reported per repo that's theirs, by their share of the Worker's object requests.
	 * Only the price: the share with the amounts it was taken of would give away the whole Worker's totals.
	 */
	shared: { cost: number };
	total: number;
	prices: typeof PRICES;
}

/** A repo of a person's, by the id its objects are named with, and the name people know it by. */
export interface OwnedRepo {
	id: string;
	fullName: string;
}

/** The repo id an object's name names, among `ids`, if any: its first or second `:`-separated part. */
export function repoOfObject(name: string, ids: Set<string>): string | undefined {
	const [first, second] = name.split(":");
	if (first && ids.has(first)) return first;
	if (second && ids.has(second)) return second;
	return undefined;
}

/** What `repos` used of the Worker's `use`, and their share of the rest. */
export function ownUsage(use: WorkerUse, worker: string, repos: OwnedRepo[]): OwnUsage {
	const ids = new Set(repos.map((repo) => repo.id));
	const byId = new Map(repos.map((repo) => [repo.id, emptyUse(repo.fullName)]));
	for (const object of use.objects) {
		const id = repoOfObject(object.name, ids);
		if (!id) continue;
		const row = byId.get(id)!;
		row.objectRequests += object.requests;
		row.activeSeconds += object.activeMs / 1000;
		row.rowsRead += object.rowsRead;
		row.rowsWritten += object.rowsWritten;
	}
	for (const repo of repos) byId.get(repo.id)!.clefNeurons = use.neurons[repoTag(worker, repo.id)] ?? 0;
	const rows = [...byId.values()].map((row) => ({ ...row, cost: repoCost(row) }));
	const shared = sharedPart(use, requestShare(use, ids));
	const used = rows.filter((row) => row.objectRequests || row.clefNeurons).sort((a, b) => b.cost - a.cost);
	const total = rounded(used.reduce((sum, row) => sum + row.cost, 0) + shared.cost);
	return { from: use.from, to: use.to, repos: used, shared, total, prices: PRICES };
}

/** The part of the Worker's object requests that went to objects of the repos `ids`, from 0 to 1. */
export function requestShare(use: WorkerUse, ids: Set<string>) {
	let all = 0;
	let theirs = 0;
	for (const object of use.objects) {
		all += object.requests;
		if (repoOfObject(object.name, ids)) theirs += object.requests;
	}
	return all ? theirs / all : 0;
}

const emptyUse = (repo: string): RepoUse => ({
	repo,
	objectRequests: 0,
	activeSeconds: 0,
	rowsRead: 0,
	rowsWritten: 0,
	clefNeurons: 0,
	cost: 0,
});

/** What a repo's objects and Clef calls cost at list prices. */
export function repoCost(row: Omit<RepoUse, "repo" | "cost">) {
	const requests = (row.objectRequests / 1e6) * PRICES.objectRequestsPerMillion;
	const duration = ((row.activeSeconds * GB_PER_ACTIVE_SECOND) / 1e6) * PRICES.gbSecondsPerMillion;
	const reads = (row.rowsRead / 1e6) * PRICES.rowsReadPerMillion;
	const writes = (row.rowsWritten / 1e6) * PRICES.rowsWrittenPerMillion;
	const clef = (row.clefNeurons / 1000) * PRICES.neuronsPerThousand;
	return rounded(requests + duration + reads + writes + clef);
}

/** Their `share` of the Worker's requests, CPU and stored data, priced, the storage for the range's part of a month. */
function sharedPart(use: WorkerUse, share: number) {
	const months = (Date.parse(use.to) - Date.parse(use.from)) / MONTH_MS;
	const workerRequests = Math.round(use.requests * share);
	const cpuMs = Math.round(use.cpuMs * share);
	const storedBytes = Math.round(use.storedBytes * share);
	const cost =
		(workerRequests / 1e6) * PRICES.workerRequestsPerMillion +
		(cpuMs / 1e6) * PRICES.cpuPerMillionMs +
		(storedBytes / 1e9) * PRICES.storedGbMonth * months;
	return { cost: rounded(cost) };
}

/** Dollars to a hundredth of a cent. */
export const rounded = (dollars: number) => Math.round(dollars * 10_000) / 10_000;
