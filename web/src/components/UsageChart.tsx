import { type KeyboardEvent, useLayoutEffect, useRef, useState } from "react";
import type { HourCost, UsageReport } from "../api";
import { cn } from "../lib/utils";
import { Box, BoxHeader, BoxTitle } from "./ui/box";

// The Usage page's chart: what the reader's repos cost over the range, as columns of comb cells, a column an hour over
// a day and every six hours over a week, by the reader's own clock. Each cell is the same round amount; ink cells are
// what their repos used, lighter ones their estimated share of the Worker's, and an empty outline a little under one
// cell. It draws in ink like the rest of the page: the lamps' colors mean other things here.

const HOUR_MS = 3_600_000;

/** The most cells a column has: the busiest one's, at the unit chosen for it. */
export const MOST_CELLS = 10;
/** A cell's corner-to-corner half width, and the gap between cells, in pixels. */
const RADIUS = 8;
const GAP = 2;
const CELL_HEIGHT = Math.sqrt(3) * RADIUS;
const STEP = CELL_HEIGHT + GAP;
const COLUMN_HEIGHT = Math.round(MOST_CELLS * STEP - GAP);

/** A bar: when it starts and ends, and what it cost. */
export interface Bar {
	start: Date;
	end: Date;
	own: number;
	shared: number;
}

/** The hours as bars: as they are over a day, folded into six-hour blocks of local time over a week. */
export function barsOf(hours: HourCost[], range: UsageReport["range"]): Bar[] {
	const bars: Bar[] = [];
	for (const hour of hours) {
		const start = blockStart(new Date(hour.hour), range);
		const last = bars.at(-1);
		if (last && last.start.getTime() === start.getTime()) {
			last.own += hour.own;
			last.shared += hour.shared;
			continue;
		}
		const length = range === "24h" ? HOUR_MS : 6 * HOUR_MS;
		bars.push({ start, end: new Date(start.getTime() + length), own: hour.own, shared: hour.shared });
	}
	return bars;
}

function blockStart(time: Date, range: UsageReport["range"]) {
	if (range === "24h") return time;
	const start = new Date(time);
	start.setHours(Math.floor(time.getHours() / 6) * 6, 0, 0, 0);
	return start;
}

/** What one cell is worth: the smallest round amount (1, 2 or 5 of a power of ten) that fits `most` in the column. */
export function cellUnit(most: number) {
	if (most <= 0) return 0.001;
	const least = most / MOST_CELLS;
	const power = 10 ** Math.floor(Math.log10(least));
	const step = [1, 2, 5, 10].find((each) => each * power >= least * (1 - 1e-9))!;
	return step * power;
}

/** A column's cells: whole cells of the reader's repos, then of their share; a trace when it's under one cell. */
export function cellsOf(bar: Bar, unit: number) {
	const total = Math.round((bar.own + bar.shared) / unit);
	const own = Math.min(total, Math.round(bar.own / unit));
	const trace = total === 0 && bar.own + bar.shared > 0;
	return { own, shared: total - own, trace };
}

const fine = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumSignificantDigits: 2 });
const cents = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

/** An amount in a bar or on the scale: to the cent, or to two figures under a cent, where an hour's cost often is. */
export function amount(dollars: number) {
	if (dollars === 0) return "$0";
	return dollars < 0.01 ? fine.format(dollars) : cents.format(dollars);
}

const time = new Intl.DateTimeFormat(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" });
const clock = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const weekday = new Intl.DateTimeFormat(undefined, { weekday: "short" });

/** A day under the axis, as "Thu 8". */
const dayOf = (start: Date) => `${weekday.format(start)} ${start.getDate()}`;

/** When a bar was, as "Tue 14:00 – 15:00". */
export const when = (bar: Bar) => time.formatRange(bar.start, bar.end);

/** The words under a bar, if it starts a stretch the axis marks: every six hours over a day, each day over a week. */
export function axisLabel(bar: Bar, range: UsageReport["range"]) {
	if (range === "7d") return bar.start.getHours() === 0 ? dayOf(bar.start) : "";
	return bar.start.getHours() % 6 === 0 ? clock.format(bar.start) : "";
}

const said = (bar: Bar) => `${when(bar)}: ${amount(bar.own)} your repos, ${amount(bar.shared)} your share`;

export function UsageChart({ usage }: { usage: UsageReport }) {
	const bars = barsOf(usage.hours ?? [], usage.range);
	const unit = cellUnit(Math.max(0, ...bars.map((bar) => bar.own + bar.shared)));
	const title = usage.range === "24h" ? "Cost by hour" : "Cost every six hours";
	return (
		<Box>
			<BoxHeader>
				<BoxTitle>{title}</BoxTitle>
				<Legend unit={unit} />
			</BoxHeader>
			{usage.hoursError ? (
				<p className="m-0 px-0.5 py-4 text-ui text-muted-foreground">
					The hours couldn't be read from Cloudflare's analytics: {usage.hoursError}
				</p>
			) : (
				<Columns bars={bars} range={usage.range} unit={unit} />
			)}
		</Box>
	);
}

function Legend({ unit }: { unit: number }) {
	return (
		<ul className="m-0 ml-auto flex list-none flex-wrap gap-x-4 gap-y-1 p-0 text-caption font-normal text-muted-foreground">
			<li className="flex items-center gap-1.5">
				<Cell className="fill-foreground" />
				Your repos
			</li>
			<li className="flex items-center gap-1.5">
				<Cell className="fill-border-strong" />
				Your share, estimated
			</li>
			<li className="tabular-nums">A cell is {amount(unit)}</li>
		</ul>
	);
}

/** One comb cell on its own, for the legend. */
function Cell({ className }: { className: string }) {
	const width = 2 * RADIUS;
	return (
		<svg aria-hidden width={width * 0.75} height={CELL_HEIGHT * 0.75} viewBox={`0 0 ${width} ${CELL_HEIGHT}`}>
			<polygon className={className} points={hexPoints(RADIUS, CELL_HEIGHT / 2)} />
		</svg>
	);
}

/** A flat-topped hexagon's corners around (cx, cy), the way comb cells stack in a column. */
function hexPoints(cx: number, cy: number) {
	const corners: string[] = [];
	for (let corner = 0; corner < 6; corner++) {
		const angle = (Math.PI / 3) * corner;
		const x = cx + RADIUS * Math.cos(angle);
		const y = cy + RADIUS * Math.sin(angle);
		corners.push(`${Math.round(x * 100) / 100},${Math.round(y * 100) / 100}`);
	}
	return corners.join(" ");
}

/** The columns over their scale, and a line above them saying what the column under the pointer or focus cost. */
function Columns({ bars, range, unit }: { bars: Bar[]; range: UsageReport["range"]; unit: number }) {
	const [shown, setShown] = useState<number | null>(null);
	const [focused, setFocused] = useState(bars.length - 1);
	const group = useRef<HTMLDivElement>(null);
	const scroller = useRef<HTMLDivElement>(null);
	// Where the columns don't all fit, the latest hours are the ones to show first.
	useLayoutEffect(() => {
		if (scroller.current) scroller.current.scrollLeft = scroller.current.scrollWidth;
	}, [bars.length]);
	const moveTo = (index: number) => {
		const next = Math.max(0, Math.min(bars.length - 1, index));
		setFocused(next);
		setShown(next);
		group.current?.querySelectorAll<HTMLElement>("[data-bar]")[next]?.focus();
	};
	const onKeyDown = (event: KeyboardEvent) => {
		const moves: Record<string, number> = { ArrowLeft: focused - 1, ArrowRight: focused + 1, Home: 0 };
		moves.End = bars.length - 1;
		if (!(event.key in moves)) return;
		event.preventDefault();
		moveTo(moves[event.key]!);
	};
	return (
		<div className="px-0.5 pt-3 pb-2">
			<p className="m-0 min-h-5 text-ui tabular-nums" aria-live="polite">
				{shown === null ? <Busiest bars={bars} range={range} /> : said(bars[shown]!)}
			</p>
			<div ref={scroller} className="mt-2 overflow-x-auto pt-2 pb-1">
				<div className="grid min-w-max grid-cols-[auto_1fr] gap-x-2">
					<Scale unit={unit} />
					<div
						ref={group}
						role="group"
						aria-label="Cost over time. The arrow keys move between columns."
						className="relative flex items-end border-b border-border-strong"
						style={{ height: COLUMN_HEIGHT + GAP }}
						onKeyDown={onKeyDown}
						onMouseLeave={() => setShown(null)}
					>
						<Rules />
						{bars.map((bar, index) => (
							<Column
								key={bar.start.toISOString()}
								bar={bar}
								unit={unit}
								active={shown === index}
								focusable={focused === index}
								onShow={() => setShown(index)}
								onFocus={() => moveTo(index)}
							/>
						))}
					</div>
					<span />
					<Axis bars={bars} range={range} />
				</div>
			</div>
		</div>
	);
}

function Busiest({ bars, range }: { bars: Bar[]; range: UsageReport["range"] }) {
	const total = (bar: Bar) => bar.own + bar.shared;
	const busiest = bars.reduce<Bar | null>((most, bar) => (!most || total(bar) > total(most) ? bar : most), null);
	if (!busiest || total(busiest) === 0) return <span className="text-muted-foreground">Nothing used yet.</span>;
	const words = range === "24h" ? "Busiest hour" : "Busiest six hours";
	return (
		<span className="text-muted-foreground">
			{words}: <span className="text-foreground">{when(busiest)}</span>, {amount(total(busiest))}
		</span>
	);
}

/** Where `cells` whole cells reach, from the bottom of a column, in pixels. */
const reach = (cells: number) => cells * STEP;

/** The amounts at half and all of the column's cells, beside the columns. */
function Scale({ unit }: { unit: number }) {
	const half = MOST_CELLS / 2;
	return (
		<div
			className="sticky left-0 z-10 min-w-10 bg-background text-right text-micro text-muted-foreground tabular-nums"
			style={{ height: COLUMN_HEIGHT + GAP }}
		>
			<span className="absolute right-0 translate-y-1/2" style={{ bottom: reach(MOST_CELLS) }}>
				{amount(unit * MOST_CELLS)}
			</span>
			<span className="absolute right-0 translate-y-1/2" style={{ bottom: reach(half) }}>
				{amount(unit * half)}
			</span>
			<span className="absolute right-0 bottom-0 translate-y-1/2">$0</span>
		</div>
	);
}

function Rules() {
	return (
		<div aria-hidden className="pointer-events-none absolute inset-0">
			{[MOST_CELLS / 2, MOST_CELLS].map((cells) => (
				<div
					key={cells}
					className="absolute inset-x-0 border-t border-dashed border-border"
					style={{ bottom: reach(cells) }}
				/>
			))}
		</div>
	);
}

function Column({
	bar,
	unit,
	active,
	focusable,
	onShow,
	onFocus,
}: {
	bar: Bar;
	unit: number;
	active: boolean;
	focusable: boolean;
	onShow(): void;
	onFocus(): void;
}) {
	const cells = cellsOf(bar, unit);
	const looks = [
		...Array<string>(cells.own).fill("fill-foreground"),
		...Array<string>(cells.shared).fill("fill-border-strong"),
	];
	if (cells.trace) looks.push("fill-none stroke-border-strong stroke-[1.5]");
	const width = 2 * RADIUS + 2;
	return (
		<div
			data-bar
			role="img"
			aria-label={said(bar)}
			tabIndex={focusable ? 0 : -1}
			className={cn(
				"relative flex h-full min-w-5 flex-1 items-end justify-center rounded-sm outline-none",
				"focus-visible:ring-2 focus-visible:ring-ring",
				active && "bg-surface-2",
			)}
			onMouseEnter={onShow}
			onFocus={onFocus}
		>
			<svg aria-hidden width={width} height={COLUMN_HEIGHT} viewBox={`-1 0 ${width} ${COLUMN_HEIGHT}`}>
				{looks.map((look, index) => (
					<polygon
						key={index}
						className={look}
						points={hexPoints(RADIUS, COLUMN_HEIGHT - index * STEP - CELL_HEIGHT / 2)}
					/>
				))}
			</svg>
		</div>
	);
}

/** The times under the columns, each under the column it starts at. */
function Axis({ bars, range }: { bars: Bar[]; range: UsageReport["range"] }) {
	return (
		<div aria-hidden className="flex pt-1 text-micro text-muted-foreground tabular-nums">
			{bars.map((bar) => (
				<span key={bar.start.toISOString()} className="relative h-4 min-w-5 flex-1">
					<span className="absolute left-0 whitespace-nowrap">{axisLabel(bar, range)}</span>
				</span>
			))}
		</div>
	);
}
