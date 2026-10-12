import { useState } from "react";
import type { HiveStatus, HostedAgentAccount } from "../api";
import { usePoll } from "../hooks/usePoll";
import { messageOf } from "../lib/errors";
import { counted } from "../lib/plural";
import { timeAgo } from "../lib/relativeTime";
import { Icon } from "./Icon";

// GitHive's hosted agents on the Agents tab: who they are and what each is on, and, for people who can write, a way
// to start some for a while or stop them. They join the hive like any agent: they take pieces of the backlog, review
// other agents' changes under their own names, and merge their own once approved.

export interface HostedAgentsApi {
	hostedAgents(repo: string): Promise<HiveStatus | null>;
	startHostedAgents?(repo: string, count: number, minutes: number): Promise<unknown>;
	stopHostedAgents?(repo: string): Promise<unknown>;
}

const COUNTS = [1, 2, 3, 4, 6, 8, 10, 12];
const DURATIONS = [15, 30, 60, 120];

/** What one agent is doing, in a few words. */
export function agentWords(agent: HostedAgentAccount): string {
	if (agent.done) return "stopped";
	if (agent.change) return `building ${agent.change}`;
	if (agent.reviewing) return `reviewing ${agent.reviewing.change}`;
	return "looking for work";
}

function AgentRows({ agents }: { agents: HostedAgentAccount[] }) {
	return (
		<ul className="agents__registered">
			{agents.map((agent) => (
				<li key={agent.name}>
					<Icon name="bot" size={14} className="muted" />
					<strong>{agent.name}</strong>
					<span className="muted">{agentWords(agent)}</span>
					<span className="muted">
						· {counted(agent.finished.length, "change")} finished, {counted(agent.reviewed, "review")}
					</span>
				</li>
			))}
		</ul>
	);
}

function StartForm({ onStart, busy }: { onStart: (count: number, minutes: number) => void; busy: boolean }) {
	const [count, setCount] = useState(3);
	const [minutes, setMinutes] = useState(60);
	return (
		<form
			className="box__row hosted-agents__form"
			onSubmit={(event) => {
				event.preventDefault();
				onStart(count, minutes);
			}}
		>
			<label>
				Agents{" "}
				<select value={count} onChange={(event) => setCount(Number(event.target.value))}>
					{COUNTS.map((option) => (
						<option key={option}>{option}</option>
					))}
				</select>
			</label>
			<label>
				For{" "}
				<select value={minutes} onChange={(event) => setMinutes(Number(event.target.value))}>
					{DURATIONS.map((option) => (
						<option key={option} value={option}>
							{option} minutes
						</option>
					))}
				</select>
			</label>
			<button type="submit" className="accent" disabled={busy}>
				Start hosted agents
			</button>
		</form>
	);
}

/** A repo's hosted agents, and starting or stopping them for people who can. */
export function HostedAgents({ repo, api }: { repo: string; api: HostedAgentsApi }) {
	const hive = usePoll(`hosted-agents:${repo}`, () => api.hostedAgents(repo), 15_000);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const act = async (action: () => Promise<unknown>) => {
		setBusy(true);
		setError(null);
		try {
			await action();
			hive.refresh();
		} catch (err) {
			setError(messageOf(err));
		} finally {
			setBusy(false);
		}
	};
	const status = hive.data;
	const working = !!status?.working;
	const { startHostedAgents, stopHostedAgents } = api;
	return (
		<section className="box" aria-labelledby="hosted-agents-title">
			<div className="box__header">
				<h2 id="hosted-agents-title">GitHive's hosted agents</h2>
			</div>
			<p className="box__row muted">
				They work like any agent here: each takes a piece of the backlog and builds it, reviews other agents' changes
				under its own name, and merges its own once approved. They take no new work once their time is up.
			</p>
			{status ? <HiveSummary status={status} /> : null}
			{status?.agents.length ? <AgentRows agents={status.agents} /> : null}
			{error ? (
				<p className="box__row error" role="alert">
					{error}
				</p>
			) : null}
			{startHostedAgents && !working ? (
				<StartForm busy={busy} onStart={(count, minutes) => act(() => startHostedAgents(repo, count, minutes))} />
			) : null}
			{stopHostedAgents && working ? (
				<div className="box__row">
					<button type="button" onClick={() => act(() => stopHostedAgents(repo))} disabled={busy}>
						Stop them
					</button>
				</div>
			) : null}
		</section>
	);
}

/** Where a repo's hosted agents stand, in a sentence. */
export function hiveWords(status: HiveStatus, now = Date.now()): string {
	const started = `${counted(status.names.length, "agent")} started by ${status.by} ${timeAgo(
		new Date(status.startedAt).toISOString(),
		now,
	)}`;
	const minutesLeft = Math.round((status.until - now) / 60_000);
	if (!status.working) return `${started}, all stopped now.`;
	if (minutesLeft <= 0) return `${started}, finishing what they started.`;
	return `${started}, taking work for ${counted(minutesLeft, "more minute")}.`;
}

function HiveSummary({ status }: { status: HiveStatus }) {
	return <p className="box__row">{hiveWords(status)}</p>;
}
