import { useState } from "react";
import type { UsageReport } from "../api";
import { usePoll } from "../hooks/usePoll";
import { cn } from "../lib/utils";
import { LoadingLine } from "./Lazy";
import { Page, PageHeader } from "./Page";
import { Box, Callout } from "./ui/box";
import { Segmented } from "./ui/segmented";

// Usage: what the reader's own repos used on Cloudflare, read by the server from Cloudflare's analytics, and what it
// costs at list prices. Their repos' Durable Objects and Clef calls are counted per repo; the Worker's requests, CPU
// and stored data aren't reported per repo, so the reader gets a share of them, marked as an estimate.

type Range = UsageReport["range"];

const RANGES: { value: Range; words: string }[] = [
	{ value: "24h", words: "24 hours" },
	{ value: "7d", words: "7 days" },
];

const TABLE = [
	"w-full border-collapse text-ui",
	"[&_td]:border-t [&_td]:border-border [&_td]:px-4 [&_td]:py-2.25 [&_td]:text-right [&_td]:whitespace-nowrap",
	"[&_th]:border-t [&_th]:border-border [&_th]:px-4 [&_th]:py-2.25 [&_th]:text-left [&_th]:whitespace-nowrap",
	"[&_thead_th]:border-t-0 [&_thead_th]:text-caption [&_thead_th]:font-semibold [&_thead_th]:text-muted-foreground",
	"[&_thead_th:not(:first-child)]:text-right [&_td]:tabular-nums [&_tbody_th]:font-semibold",
].join(" ");

const count = new Intl.NumberFormat("en-US");
const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });

/** Dollars as a bill shows them, with cents; under a cent, so. */
export function dollars(amount: number) {
	if (amount > 0 && amount < 0.01) return "under $0.01";
	return `$${amount.toFixed(2)}`;
}

/** A length of time from seconds: "42 s", "18 min", "3.4 h". */
export function duration(seconds: number) {
	if (seconds < 60) return `${Math.round(seconds)} s`;
	if (seconds < 3600) return `${Math.round(seconds / 60)} min`;
	return `${(seconds / 3600).toFixed(1)} h`;
}

const bytes = (amount: number) => `${(amount / 1e6).toFixed(1)} MB`;

export function UsagePage({ load }: { load: (range: Range) => Promise<UsageReport> }) {
	const [range, setRange] = useState<Range>("24h");
	const usage = usePoll(`usage:${range}`, () => load(range), 600_000);
	return (
		<Page>
			<PageHeader
				title="Usage"
				description="What your own repos used on Cloudflare, and what it costs at Cloudflare's list prices."
				actions={<Segmented<Range> label="Time range" options={RANGES} value={range} onPick={setRange} />}
			/>
			{usage.error ? (
				<Callout tone="warn" role="alert">
					<p>{usage.error}</p>
				</Callout>
			) : usage.data ? (
				<UsageTable usage={usage.data} />
			) : (
				<LoadingLine />
			)}
		</Page>
	);
}

/** Each of the reader's repos that used anything, their share of the rest, and the total, then how it's counted. */
export function UsageTable({ usage }: { usage: UsageReport }) {
	const { repos, shared } = usage;
	return (
		<div className="grid gap-3">
			<Box>
				<div className="overflow-x-auto">
					<table className={TABLE}>
						<thead>
							<tr>
								<th scope="col">Repository</th>
								<th scope="col">Object requests</th>
								<th scope="col">Active time</th>
								<th scope="col">Rows written</th>
								<th scope="col">Clef neurons</th>
								<th scope="col">Cost</th>
							</tr>
						</thead>
						<tbody>
							{repos.map((repo) => (
								<tr key={repo.repo}>
									<th scope="row" className="wrap-anywhere whitespace-normal">
										{repo.repo}
									</th>
									<td>{compact.format(repo.objectRequests)}</td>
									<td>{duration(repo.activeSeconds)}</td>
									<td>{compact.format(repo.rowsWritten)}</td>
									<td>{count.format(Math.round(repo.clefNeurons))}</td>
									<td>{dollars(repo.cost)}</td>
								</tr>
							))}
							<tr>
								<th scope="row" className="font-normal whitespace-normal text-muted-foreground">
									Your share of the Worker ({Math.round(shared.share * 100)}%, estimated):{" "}
									{compact.format(shared.workerRequests)} requests, {count.format(Math.round(shared.cpuMs / 1000))} s of
									CPU, {bytes(shared.storedBytes)} stored
								</th>
								<td colSpan={4} />
								<td>{dollars(shared.cost)}</td>
							</tr>
							<tr className="[&_td]:font-semibold">
								<th scope="row">Total</th>
								<td colSpan={4} />
								<td>{dollars(usage.total)}</td>
							</tr>
						</tbody>
					</table>
				</div>
				{repos.length ? null : (
					<p className="m-0 border-t border-border px-4 py-3 text-ui text-muted-foreground">
						Your repos used nothing in this range.
					</p>
				)}
			</Box>
			<p className={cn("m-0 max-w-measure text-meta text-muted-foreground")}>
				Priced at list prices before the Workers Paid plan's monthly allowances, so the real bill is lower. Durable
				Objects and Clef are counted per repo; Clef from 14 Oct, when GitHive began tagging its calls. The Worker's own
				requests, CPU and stored data aren't reported per repo, so your share of them follows your repos' share of
				object requests. Cloudflare's analytics run a few minutes behind.
			</p>
		</div>
	);
}
