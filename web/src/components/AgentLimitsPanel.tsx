import { useEffect, useRef, useState } from "react";
import type { AgentLimits, MyAgent } from "../api";
import { useChanged } from "../hooks/useChanged";
import { useLingering } from "../hooks/useLingering";
import { cn } from "../lib/utils";
import type { RowShared } from "./AgentRow";
import { Input, Label, NativeSelect } from "./ui/field";

type Kind = keyof AgentLimits;

// In a repo shared with other people, their backlog pieces and their changes' reviews are work for them, on this
// agent's owner's model account. The owner sets how much of it the agent does; GitHive keeps to it.

const LABELS: Record<Kind, string> = {
	build: "Build their backlog pieces",
	review: "Review their changes",
};

/** The default when none are recorded: doing nothing for other people. */
const DEFAULT_LIMITS: AgentLimits = { build: 0, review: 0 };

type Choice = "never" | "daily" | "any";

const choiceOf = (limit: number | null): Choice => {
	if (limit === null) return "any";
	return limit === 0 ? "never" : "daily";
};

/** The number a day, for a limit that is one: not never (0), not no limit (null). */
const dailyOf = (limit: number | null) => (choiceOf(limit) === "daily" ? limit : null);

/**
 * The limit a choice saves: 0 for never, null for no limit, and for a daily one the number given, as a whole number.
 * Undefined while that isn't at least 1: nothing is saved until it is.
 */
export function nextLimit(choice: Choice, perDay: number): number | null | undefined {
	if (choice === "never") return 0;
	if (choice === "any") return null;
	const count = Math.floor(perDay);
	return Number.isFinite(count) && count >= 1 ? count : undefined;
}

/** How much the agent does for other people a day, and how much it did today. */
export function AgentLimitsPanel({
	agent,
	actions,
	run,
	setError,
}: Pick<RowShared, "actions" | "run"> & { agent: MyAgent; setError: (text: string) => void }) {
	const limits = agent.limits ?? DEFAULT_LIMITS;
	const today = agent.today ?? { build: 0, review: 0 };
	const key = `limits:${agent.id}`;
	// The limit saved last, said for a moment.
	const [saved, setSaved] = useState<Kind | null>(null);
	useEffect(() => {
		if (!saved) return;
		const timer = setTimeout(() => setSaved(null), 2000);
		return () => clearTimeout(timer);
	}, [saved]);
	const save = async (kind: Kind, limit: number | null) => {
		setSaved(null);
		const ok = await run(key, () => actions.setLimits(agent.id, { [kind]: limit }), setError);
		if (ok) setSaved(kind);
		return ok;
	};
	// Never disabled while it saves: that would drop the focus of someone who pressed Enter in it. A limit already
	// sent isn't sent again (LimitField).
	return (
		<fieldset className="m-0 grid min-w-0 gap-1.5 border-0 p-0">
			<legend className="mb-1 p-0 text-ui text-muted-foreground">
				Work for other people, in repos you share with them
			</legend>
			{(["build", "review"] as const).map((kind) => (
				<LimitField
					key={kind}
					id={`${kind}-${agent.id}`}
					label={LABELS[kind]}
					limit={limits[kind]}
					done={today[kind]}
					save={(limit) => save(kind, limit)}
					saved={saved === kind}
				/>
			))}
		</fieldset>
	);
}

/**
 * One limit: never, a number a day, or no limit. Never and no limit save as they're chosen; a number a day once it's
 * given, on Enter or on leaving its field. A number that isn't one (empty, 0) saves nothing and puts back what's saved.
 *
 * Choosing a number a day shows its field and leaves focus on the choice: on Windows and Linux the arrow keys change a
 * select's value as they go, so moving focus would take it away mid-arrow. The field is the next Tab away. Leaving the
 * choice for anywhere but its field settles it as leaving the field does.
 */
export function LimitField({
	id,
	label,
	limit,
	done,
	save,
	saved = false,
}: {
	id: string;
	label: string;
	limit: number | null;
	done: number;
	/** Saves a limit; resolves to whether it was. */
	save: (limit: number | null) => Promise<boolean>;
	/** Just saved: it says so. */
	saved?: boolean;
}) {
	// What's chosen shows at once, ahead of what's saved: a number a day waits for its number.
	const [choice, setChoice] = useState(choiceOf(limit));
	// The number a day as typed; the last one given stays for when a number a day is chosen again.
	const [typed, setTyped] = useState(String(dailyOf(limit) ?? ""));
	// The limit last sent, so that leaving the field after Enter doesn't send it twice.
	const sent = useRef(limit);
	const field = useRef<HTMLInputElement>(null);
	useEffect(() => {
		sent.current = limit;
		setChoice(choiceOf(limit));
		const daily = dailyOf(limit);
		if (daily) setTyped(String(daily));
	}, [limit]);
	// The field comes in as it's chosen; one there from the start comes with the page.
	const chosen = useChanged(choice);
	const shown = useLingering(saved, 250);

	const commit = (next: number | null | undefined) => {
		if (next === undefined || next === sent.current) return;
		sent.current = next;
		void save(next).then((ok) => {
			if (ok) return;
			sent.current = limit;
			setChoice(choiceOf(limit));
		});
	};
	const choose = (next: Choice) => {
		setChoice(next);
		if (next !== "daily") commit(nextLimit(next, Number(typed)));
	};
	/** Saves the number typed, if it's one; otherwise puts back what's saved, and on leaving, a choice that isn't. */
	const commitTyped = (leaving: boolean) => {
		const next = nextLimit("daily", Number(typed));
		if (next !== undefined) return commit(next);
		const daily = dailyOf(limit);
		if (daily) setTyped(String(daily));
		else if (leaving) setChoice(choiceOf(limit));
	};
	return (
		<div className="flex flex-wrap items-center gap-2">
			<Label htmlFor={id} className="min-w-48 font-normal">
				{label}
			</Label>
			<NativeSelect
				id={id}
				className="px-1.5 py-0.75 text-ui"
				value={choice}
				onChange={(event) => choose(event.target.value as Choice)}
				onBlur={(event) => {
					if (choice === "daily" && event.relatedTarget !== field.current) commitTyped(true);
				}}
			>
				<option value="never">Never</option>
				<option value="daily">Up to a number a day</option>
				<option value="any">No limit</option>
			</NativeSelect>
			{choice === "daily" ? (
				<Input
					ref={field}
					type="number"
					min={1}
					className={cn("w-16 px-1.5 py-0.75 text-ui", chosen && "animate-appear")}
					aria-label={`${label}: at most a day`}
					value={typed}
					onChange={(event) => setTyped(event.target.value)}
					onKeyDown={(event) => {
						if (event.key !== "Enter") return;
						event.preventDefault();
						commitTyped(false);
					}}
					onBlur={() => commitTyped(true)}
				/>
			) : null}
			<span className="text-meta text-muted-foreground">{done} today</span>
			<span role="status" className="text-meta text-good">
				{shown ? <span className={cn("inline-block", saved ? "animate-appear" : "animate-leave")}>Saved</span> : null}
			</span>
		</div>
	);
}
