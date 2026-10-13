import { fail } from "../errors";

// How much an agent does for other people: its owner's limits, a day at a time (UTC), and the counts against them.
// GitHive keeps to the owner's choice where such work starts (claiming another person's backlog piece, taking a
// review) and decides nothing else: within its limits, the agent chooses as always.

export type EffortKind = "build" | "review";

/** The most a day of each kind: 0 is never, null is no limit. */
export interface AgentLimits {
	build: number | null;
	review: number | null;
}

/** What GitHive asks of an agent's limits, for the agent the call is from. */
export interface OwnerLimits {
	/** Why the agent may do no more of `kind` for others today, or null if it may. Counts nothing. */
	reached(kind: EffortKind): Promise<string | null>;
	/** Counts one more of `kind` for others, or says why the agent may not. Two calls can't both take the last one. */
	take(kind: EffortKind): Promise<string | null>;
}

const today = (now = Date.now()) => new Date(now).toISOString().slice(0, 10);

const WORK: Record<EffortKind, string> = {
	build: "build other people's backlog pieces",
	review: "review other people's changes",
};

function refusal(kind: EffortKind, limit: number) {
	const allows =
		limit === 0
			? `doesn't let this agent ${WORK[kind]}`
			: `lets this agent ${WORK[kind]} up to ${limit} times a day, and it has today`;
	return `Its owner ${allows}. They can change that on GitHive's Agents page. Meanwhile, work on your own changes.`;
}

function limitFrom(value: unknown, kind: EffortKind): number | null {
	if (value === null) return null;
	const refused = `${kind} is a whole number a day (0 for never), or null for no limit`;
	if (typeof value !== "number") fail(400, refused);
	if (!Number.isInteger(value)) fail(400, refused);
	if (value < 0) fail(400, refused);
	return value;
}

/** The limits a request asks for, each left as it was when not given. */
export function limitsFrom(body: Record<string, unknown>, current: AgentLimits): AgentLimits {
	return {
		build: body.build === undefined ? current.build : limitFrom(body.build, "build"),
		review: body.review === undefined ? current.review : limitFrom(body.review, "review"),
	};
}

export class AgentLimitStore {
	constructor(
		private readonly db: D1Database,
		private readonly now: () => number = Date.now,
	) {}

	async limitsOf(agentId: string): Promise<AgentLimits> {
		const row = await this.db
			.prepare("SELECT build_limit, review_limit FROM agents WHERE id = ?")
			.bind(agentId)
			.first<{ build_limit: number | null; review_limit: number | null }>();
		return { build: row?.build_limit ?? null, review: row?.review_limit ?? null };
	}

	/** Sets an agent's limits; the caller has checked it's the owner's own agent. */
	async setLimits(agentId: string, limits: AgentLimits) {
		await this.db
			.prepare("UPDATE agents SET build_limit = ?, review_limit = ? WHERE id = ?")
			.bind(limits.build, limits.review, agentId)
			.run();
	}

	/** What each of these agents did for others today, by kind. */
	async countsToday(agentIds: string[]): Promise<Record<string, Record<EffortKind, number>>> {
		const counts: Record<string, Record<EffortKind, number>> = {};
		for (const id of agentIds) counts[id] = { build: 0, review: 0 };
		if (!agentIds.length) return counts;
		const marks = agentIds.map(() => "?").join(", ");
		const rows = await this.db
			.prepare(`SELECT agent_id, kind, count FROM agent_effort WHERE day = ? AND agent_id IN (${marks})`)
			.bind(today(this.now()), ...agentIds)
			.all<{ agent_id: string; kind: EffortKind; count: number }>();
		for (const row of rows.results) counts[row.agent_id]![row.kind] = row.count;
		return counts;
	}

	/** The limits of one agent, as GitHive's tools ask them. */
	ownerLimits(agentId: string): OwnerLimits {
		return {
			reached: async (kind) => {
				const limit = (await this.limitsOf(agentId))[kind];
				if (limit === null) return null;
				const done = (await this.countsToday([agentId]))[agentId]![kind];
				return done < limit ? null : refusal(kind, limit);
			},
			take: async (kind) => {
				const limit = (await this.limitsOf(agentId))[kind];
				if (limit === 0) return refusal(kind, 0);
				return (await this.count(agentId, kind, limit)) ? null : refusal(kind, limit!);
			},
		};
	}

	// One statement, so two calls can't both take the last one: it adds one only while under the limit.
	private async count(agentId: string, kind: EffortKind, limit: number | null) {
		const under = limit === null ? "" : " WHERE count < ?";
		const statement = this.db.prepare(
			"INSERT INTO agent_effort (agent_id, day, kind, count) VALUES (?, ?, ?, 1) " +
				`ON CONFLICT (agent_id, day, kind) DO UPDATE SET count = count + 1${under}`,
		);
		const values: (string | number)[] = [agentId, today(this.now()), kind];
		if (limit !== null) values.push(limit);
		const result = await statement.bind(...values).run();
		return result.meta.changes > 0;
	}
}
