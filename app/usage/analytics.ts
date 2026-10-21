// What this Worker used on Cloudflare, from the GraphQL Analytics API: its Durable Objects by name, its own requests
// and CPU, its objects' stored data, and Workers AI calls by tag. It's the whole Worker's, so it stays on the server:
// own-usage.ts gives each person only what their repos used. One read serves everyone for ten minutes, and analytics
// lag a few minutes behind.

import { keptFor } from "./kept";

const GRAPHQL = "https://api.cloudflare.com/client/v4/graphql";

/** How long one read of the analytics serves every reader. */
const KEPT_SECONDS = 600;

export type UsageRange = "24h" | "7d";
export const RANGE_MS: Record<UsageRange, number> = { "24h": 24 * 3_600_000, "7d": 7 * 24 * 3_600_000 };

/** The Worker's secrets and name for reading its analytics. */
export interface UsageEnv {
	CF_ANALYTICS_TOKEN?: string;
	CF_ACCOUNT_ID?: string;
	WORKER_NAME?: string;
}

/** One Durable Object, by the name it was made with (`repo:<id>`, `agent:<id>:<agent>`, ...). */
export interface ObjectUse {
	name: string;
	requests: number;
	activeMs: number;
	rowsRead: number;
	rowsWritten: number;
}

export interface WorkerUse {
	from: string;
	to: string;
	objects: ObjectUse[];
	requests: number;
	cpuMs: number;
	/** The most its objects stored at once, all classes together. */
	storedBytes: number;
	/** Workers AI neurons by tag; untagged calls under "". */
	neurons: Record<string, number>;
	/** The Worker's Durable Object classes, which the periodic metrics are filtered by. */
	namespaces: string[];
}

/** This Worker's name, as the analytics know it. */
export const workerName = (env: UsageEnv) => env.WORKER_NAME ?? "";

/** Whether the usage can be read here: the token, the account and the Worker's name are all set. */
export const canReadUsage = (env: UsageEnv) => !!(env.CF_ANALYTICS_TOKEN && env.CF_ACCOUNT_ID && env.WORKER_NAME);

const OBJECTS = `query($account: String!, $start: Time!, $end: Time!, $worker: String!) {
	viewer { accounts(filter: { accountTag: $account }) {
		objects: durableObjectsInvocationsAdaptiveGroups(
			limit: 10000, filter: { datetime_geq: $start, datetime_leq: $end, scriptName: $worker }
		) { sum { requests } dimensions { name namespaceId } }
		worker: workersInvocationsAdaptive(
			limit: 10, filter: { datetime_geq: $start, datetime_leq: $end, scriptName: $worker }
		) { sum { requests cpuTimeUs } }
		ai: aiInferenceAdaptiveGroups(limit: 10000, filter: { datetime_geq: $start, datetime_leq: $end }) {
			sum { totalNeurons } dimensions { tag }
		}
	} }
}`;

// Periodic metrics and storage have no Worker name to filter by, only the classes' namespace ids, which the first
// query finds.
const BY_NAMESPACE = `query($account: String!, $start: Time!, $end: Time!, $namespaces: [String!]) {
	viewer { accounts(filter: { accountTag: $account }) {
		periodic: durableObjectsPeriodicGroups(
			limit: 10000, filter: { datetime_geq: $start, datetime_leq: $end, namespaceId_in: $namespaces }
		) { sum { activeTime rowsRead rowsWritten } dimensions { name } }
		storage: durableObjectsSqlStorageGroups(
			limit: 1000, filter: { datetime_geq: $start, datetime_leq: $end, namespaceId_in: $namespaces }
		) { max { storedBytes } dimensions { namespaceId } }
	} }
}`;

type Sum = Record<string, number>;
export type Group = { sum?: Sum; max?: Sum; dimensions?: Record<string, string> };

/** One query of the account's analytics, with the account filled in. */
export async function query(env: UsageEnv, text: string, variables: Record<string, unknown>) {
	const response = await fetch(GRAPHQL, {
		method: "POST",
		headers: { Authorization: `Bearer ${env.CF_ANALYTICS_TOKEN}`, "Content-Type": "application/json" },
		body: JSON.stringify({ query: text, variables: { account: env.CF_ACCOUNT_ID, ...variables } }),
	});
	const body = (await response.json().catch(() => null)) as {
		data?: { viewer: { accounts: Record<string, Group[]>[] } };
		errors?: { message: string }[];
	} | null;
	const account = body?.data?.viewer.accounts[0];
	if (!response.ok || body?.errors?.length || !account)
		throw new Error(`Cloudflare's analytics answered ${response.status}: ${body?.errors?.[0]?.message ?? "no data"}`);
	return account;
}

/** What this Worker used over `range`, read at most every ten minutes from `origin`'s cache. */
export function workerUse(env: UsageEnv, range: UsageRange, origin: string) {
	return keptFor(origin, `usage/${workerName(env)}/${range}`, KEPT_SECONDS, () => readWorkerUse(env, range));
}

async function readWorkerUse(env: UsageEnv, range: UsageRange): Promise<WorkerUse> {
	const to = new Date();
	const from = new Date(to.getTime() - RANGE_MS[range]);
	const window = { start: from.toISOString(), end: to.toISOString() };
	const first = await query(env, OBJECTS, { ...window, worker: workerName(env) });
	const invoked = first.objects ?? [];
	const namespaces = [...new Set(invoked.map((group) => group.dimensions?.namespaceId ?? ""))].filter(Boolean);
	const second = namespaces.length ? await query(env, BY_NAMESPACE, { ...window, namespaces }) : {};
	const worker = first.worker?.[0]?.sum ?? {};
	return {
		from: window.start,
		to: window.end,
		objects: objectsOf(invoked, second.periodic ?? []),
		requests: worker.requests ?? 0,
		cpuMs: Math.round((worker.cpuTimeUs ?? 0) / 1000),
		storedBytes: (second.storage ?? []).reduce((total, group) => total + (group.max?.storedBytes ?? 0), 0),
		neurons: neuronsByTag(first.ai ?? []),
		namespaces,
	};
}

/** Each named object's requests and periodic metrics together. Objects made by id, with no name, are left out. */
function objectsOf(invoked: Group[], periodic: Group[]): ObjectUse[] {
	const byName = new Map<string, ObjectUse>();
	const objectNamed = (name: string) => {
		let object = byName.get(name);
		if (!object) byName.set(name, (object = { name, requests: 0, activeMs: 0, rowsRead: 0, rowsWritten: 0 }));
		return object;
	};
	for (const group of invoked) {
		const name = group.dimensions?.name;
		if (name) objectNamed(name).requests += group.sum?.requests ?? 0;
	}
	for (const group of periodic) {
		const name = group.dimensions?.name;
		if (!name) continue;
		const object = objectNamed(name);
		// activeTime is in microseconds.
		object.activeMs += Math.round((group.sum?.activeTime ?? 0) / 1000);
		object.rowsRead += group.sum?.rowsRead ?? 0;
		object.rowsWritten += group.sum?.rowsWritten ?? 0;
	}
	return [...byName.values()];
}

function neuronsByTag(groups: Group[]) {
	const neurons: Record<string, number> = {};
	for (const group of groups) {
		const tag = group.dimensions?.tag ?? "";
		neurons[tag] = (neurons[tag] ?? 0) + (group.sum?.totalNeurons ?? 0);
	}
	return neurons;
}
