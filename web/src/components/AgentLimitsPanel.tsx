import { useEffect, useState } from "react";
import type { AgentLimits, MyAgent } from "../api";
import type { RowShared } from "./AgentRow";

type Kind = keyof AgentLimits;

// In a repo shared with other people, their backlog pieces and their changes' reviews are work for them, on this
// agent's owner's model account. The owner sets how much of it the agent does; GitHive keeps to it.

const LABELS: Record<Kind, string> = {
	build: "Build their backlog pieces",
	review: "Review their changes",
};

/** The default for an agent made before limits: building nothing of other people's, reviewing without limit. */
const DEFAULT_LIMITS: AgentLimits = { build: 0, review: null };

type Choice = "never" | "daily" | "any";

const choiceOf = (limit: number | null): Choice => {
	if (limit === null) return "any";
	return limit === 0 ? "never" : "daily";
};

/** The number a day, for a limit that is one: not never (0), not no limit (null). */
const dailyOf = (limit: number | null) => (choiceOf(limit) === "daily" ? limit : null);

/** A count typed in, as a whole number of at least 1. */
function wholeCount(typed: string) {
	const count = Math.floor(Number(typed));
	return Number.isFinite(count) ? Math.max(1, count) : 1;
}

/** How much the agent does for other people a day, and how much it did today. */
export function AgentLimitsPanel({
	agent,
	actions,
	run,
	busy,
	setError,
}: Pick<RowShared, "actions" | "run" | "busy"> & { agent: MyAgent; setError: (text: string) => void }) {
	const limits = agent.limits ?? DEFAULT_LIMITS;
	const today = agent.today ?? { build: 0, review: 0 };
	const key = `limits:${agent.id}`;
	const save = (patch: Partial<AgentLimits>) => run(key, () => actions.setLimits(agent.id, patch), setError);
	return (
		<fieldset className="agents__limits" disabled={busy !== null}>
			<legend>Work for other people, in repos you share with them</legend>
			{(["build", "review"] as const).map((kind) => (
				<LimitField
					key={kind}
					id={`${kind}-${agent.id}`}
					label={LABELS[kind]}
					limit={limits[kind]}
					done={today[kind]}
					save={(limit) => save({ [kind]: limit })}
				/>
			))}
		</fieldset>
	);
}

function LimitField({
	id,
	label,
	limit,
	done,
	save,
}: {
	id: string;
	label: string;
	limit: number | null;
	done: number;
	save: (limit: number | null) => void;
}) {
	const [perDay, setPerDay] = useState(dailyOf(limit) ?? 5);
	useEffect(() => {
		const daily = dailyOf(limit);
		if (daily) setPerDay(daily);
	}, [limit]);
	const choose = (choice: Choice) => {
		if (choice === "never") save(0);
		else if (choice === "any") save(null);
		else save(perDay);
	};
	return (
		<div className="agents__limit">
			<label htmlFor={id}>{label}</label>
			<select id={id} value={choiceOf(limit)} onChange={(event) => choose(event.target.value as Choice)}>
				<option value="never">Never</option>
				<option value="daily">Up to a number a day</option>
				<option value="any">No limit</option>
			</select>
			{choiceOf(limit) === "daily" ? (
				<input
					type="number"
					min={1}
					className="agents__limit-count"
					aria-label={`${label}: at most a day`}
					value={perDay}
					onChange={(event) => setPerDay(wholeCount(event.target.value))}
					onBlur={() => save(perDay)}
				/>
			) : null}
			<span className="muted agents__meta">{done} today</span>
		</div>
	);
}
