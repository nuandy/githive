import { repoTag } from "../clef";
import { type Group, query, type UsageEnv, type WorkerUse, workerName } from "./analytics";
import { MONTH_MS, type OwnedRepo, PRICES, repoCost, repoOfObject, requestShare } from "./own-usage";

// The Usage page's chart: what one person's repos cost hour by hour, priced as the table prices them, over the same
// window as the table's read, so the hours add up to its total. Only their own objects and Clef tags are asked for,
// so each answer is at most a row an hour.

const HOUR_MS = 3_600_000;

/** How long one person's hours serve them; the same as the Worker's read they're split from. */
const KEPT_SECONDS = 600;

/** One hour of a person's usage, priced: their repos' part, and their estimated share of the Worker's. */
export interface HourCost {
	hour: string;
	own: number;
	shared: number;
}

const HOURLY = `query(
	$account: String!, $start: Time!, $end: Time!, $worker: String!,
	$names: [String!], $namespaces: [String!], $tags: [String!]
) {
	viewer { accounts(filter: { accountTag: $account }) {
		objects: durableObjectsInvocationsAdaptiveGroups(
			limit: 1000, filter: { datetime_geq: $start, datetime_leq: $end, scriptName: $worker, name_in: $names }
		) { sum { requests } dimensions { datetimeHour } }
		periodic: durableObjectsPeriodicGroups(
			limit: 1000,
			filter: { datetime_geq: $start, datetime_leq: $end, namespaceId_in: $namespaces, name_in: $names }
		) { sum { activeTime rowsRead rowsWritten } dimensions { datetimeHour } }
		worker: workersInvocationsAdaptive(
			limit: 1000, filter: { datetime_geq: $start, datetime_leq: $end, scriptName: $worker }
		) { sum { requests cpuTimeUs } dimensions { datetimeHour } }
		ai: aiInferenceAdaptiveGroups(
			limit: 1000, filter: { datetime_geq: $start, datetime_leq: $end, tag_in: $tags }
		) { sum { totalNeurons } dimensions { datetimeHour } }
	} }
}`;

/** The analytics' answer for one person's hours, each list grouped by hour. */
export interface HourlyRead {
	objects: Group[];
	periodic: Group[];
	worker: Group[];
	ai: Group[];
}

/** What `repos` cost in each hour of the Worker's read `use`, kept for ten minutes under `reader`. */
export async function ownHours(env: UsageEnv, use: WorkerUse, repos: OwnedRepo[], reader: string) {
	const key = new Request(
		`https://usage.githive.internal/${workerName(env)}/hours/${use.from}/${encodeURIComponent(reader)}`,
	);
	const kept = await caches.default.match(key);
	if (kept) return (await kept.json()) as HourCost[];
	const hours = hourlyCosts(use, workerName(env), repos, await readHours(env, use, repos));
	const stored = new Response(JSON.stringify(hours), { headers: { "Cache-Control": `max-age=${KEPT_SECONDS}` } });
	await caches.default.put(key, stored);
	return hours;
}

async function readHours(env: UsageEnv, use: WorkerUse, repos: OwnedRepo[]): Promise<HourlyRead> {
	const ids = new Set(repos.map((repo) => repo.id));
	const names = use.objects.map((object) => object.name).filter((name) => repoOfObject(name, ids));
	if (!names.length) return { objects: [], periodic: [], worker: [], ai: [] };
	const answer = await query(env, HOURLY, {
		start: use.from,
		end: use.to,
		worker: workerName(env),
		names,
		namespaces: use.namespaces ?? [],
		tags: repos.map((repo) => repoTag(workerName(env), repo.id)),
	});
	return {
		objects: answer.objects ?? [],
		periodic: answer.periodic ?? [],
		worker: answer.worker ?? [],
		ai: answer.ai ?? [],
	};
}

interface HourAmounts {
	objectRequests: number;
	activeSeconds: number;
	rowsRead: number;
	rowsWritten: number;
	clefNeurons: number;
	workerRequests: number;
	cpuMs: number;
}

/**
 * Every hour of `use`'s window, oldest first, with what `repos` cost in it. Their share of the Worker's requests and
 * CPU follows the Worker's own hours; stored data costs the same each hour.
 */
export function hourlyCosts(use: WorkerUse, worker: string, repos: OwnedRepo[], read: HourlyRead): HourCost[] {
	const hours = hoursBetween(use.from, use.to);
	const amounts = new Map(hours.map((hour) => [hour, emptyHour()]));
	const at = (group: Group) => amounts.get(hourOf(group.dimensions?.datetimeHour ?? "", hours));
	for (const group of read.objects) addTo(at(group), { objectRequests: group.sum?.requests });
	for (const group of read.periodic) {
		const sum = group.sum ?? {};
		const activeSeconds = (sum.activeTime ?? 0) / 1e6;
		addTo(at(group), { activeSeconds, rowsRead: sum.rowsRead, rowsWritten: sum.rowsWritten });
	}
	for (const group of read.worker) {
		const cpuMs = (group.sum?.cpuTimeUs ?? 0) / 1000;
		addTo(at(group), { workerRequests: group.sum?.requests, cpuMs });
	}
	const tags = new Set(repos.map((repo) => repoTag(worker, repo.id)));
	for (const group of read.ai) {
		if (tags.has(group.dimensions?.tag ?? "")) addTo(at(group), { clefNeurons: group.sum?.totalNeurons });
	}
	const share = requestShare(use, new Set(repos.map((repo) => repo.id)));
	const storage = storagePerHour(use, share, hours.length);
	return hours.map((hour) => {
		const amount = amounts.get(hour)!;
		const shared = share * workerCost(amount) + storage;
		return { hour, own: toMillionths(repoCost(amount)), shared: toMillionths(shared) };
	});
}

/** The start of each whole hour from `from`'s to `to`'s, as ISO times. */
function hoursBetween(from: string, to: string) {
	const first = Math.floor(Date.parse(from) / HOUR_MS) * HOUR_MS;
	const hours: string[] = [];
	for (let hour = first; hour <= Date.parse(to); hour += HOUR_MS) hours.push(new Date(hour).toISOString());
	return hours;
}

/** The hour in `hours` that an analytics hour falls in; one outside the window counts in its nearest end. */
function hourOf(datetimeHour: string, hours: string[]) {
	const time = Date.parse(datetimeHour);
	if (Number.isNaN(time) || time <= Date.parse(hours[0]!)) return hours[0]!;
	return new Date(Math.min(time, Date.parse(hours.at(-1)!))).toISOString();
}

const emptyHour = (): HourAmounts => ({
	objectRequests: 0,
	activeSeconds: 0,
	rowsRead: 0,
	rowsWritten: 0,
	clefNeurons: 0,
	workerRequests: 0,
	cpuMs: 0,
});

function addTo(amounts: HourAmounts | undefined, more: Partial<Record<keyof HourAmounts, number | undefined>>) {
	if (!amounts) return;
	for (const [name, value] of Object.entries(more)) amounts[name as keyof HourAmounts] += value ?? 0;
}

const workerCost = (amount: HourAmounts) =>
	(amount.workerRequests / 1e6) * PRICES.workerRequestsPerMillion + (amount.cpuMs / 1e6) * PRICES.cpuPerMillionMs;

/** Their share of the window's stored data, priced, spread evenly over its hours. */
function storagePerHour(use: WorkerUse, share: number, hourCount: number) {
	const months = (Date.parse(use.to) - Date.parse(use.from)) / MONTH_MS;
	const storage = ((use.storedBytes * share) / 1e9) * PRICES.storedGbMonth * months;
	return hourCount ? storage / hourCount : 0;
}

/** Dollars to a millionth: an hour's cost is often well under a cent, and the chart still has to show it. */
const toMillionths = (dollars: number) => Math.round(dollars * 1e6) / 1e6;
