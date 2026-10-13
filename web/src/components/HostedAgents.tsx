import { useState } from "react";
import type { HiveStatus, HostedAgentAccount } from "../api";
import { usePoll } from "../hooks/usePoll";
import { messageOf } from "../lib/errors";
import { counted } from "../lib/plural";
import { timeAgo } from "../lib/relativeTime";
import { cn } from "../lib/utils";
import { Icon } from "./Icon";
import { Box, BoxHeader } from "./ui/box";
import { Button } from "./ui/button";
import { Label, NativeSelect } from "./ui/field";
import { LINE } from "./ui/manage";

// GitHive's hosted agents on the Agents tab: who they are and what each is on, and, for people who can write, a way
// to start some for a while or stop them. They join the hive like any agent: they take pieces of the backlog, review
// other agents' changes under their own names, and merge their own once approved.

export interface HostedAgentsApi {
	hostedAgents(repo: string): Promise<HiveStatus | null>;
	startHostedAgents?(repo: string, count: number, minutes: number): Promise<unknown>;
	stopHostedAgents?(repo: string): Promise<unknown>;
}

const COUNTS = [1, 2, 3, 4, 6, 8, 10, 13];
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
		<ul className="m-0 list-none p-0">
			{agents.map((agent) => (
				<li
					key={agent.name}
					className="flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-border px-4 py-2.5 wrap-anywhere first:border-t-0"
				>
					<Icon name="bot" size={14} className="text-muted-foreground" />
					<strong>{agent.name}</strong>
					<span className="text-muted-foreground">{agentWords(agent)}</span>
					<span className="text-muted-foreground">
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
			className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-border px-0.5 py-3"
			onSubmit={(event) => {
				event.preventDefault();
				onStart(count, minutes);
			}}
		>
			<Label>
				Agents{" "}
				<NativeSelect value={count} onChange={(event) => setCount(Number(event.target.value))}>
					{COUNTS.map((option) => (
						<option key={option}>{option}</option>
					))}
				</NativeSelect>
			</Label>
			<Label>
				For{" "}
				<NativeSelect value={minutes} onChange={(event) => setMinutes(Number(event.target.value))}>
					{DURATIONS.map((option) => (
						<option key={option} value={option}>
							{option} minutes
						</option>
					))}
				</NativeSelect>
			</Label>
			<Button type="submit" variant="primary" disabled={busy}>
				Start hosted agents
			</Button>
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
		<Box aria-labelledby="hosted-agents-title">
			<BoxHeader>
				<h2 id="hosted-agents-title" className="text-body-sm">
					GitHive's hosted agents
				</h2>
			</BoxHeader>
			<p className={cn(LINE, "text-muted-foreground")}>
				They work like any agent here: each takes a piece of the backlog and builds it, reviews other agents' changes
				under its own name, and merges its own once approved. They take no new work once their time is up.
			</p>
			{status ? <HiveSummary status={status} /> : null}
			{status?.agents.length ? <AgentRows agents={status.agents} /> : null}
			{error ? (
				<p className={cn(LINE, "animate-appear text-bad")} role="alert">
					{error}
				</p>
			) : null}
			{startHostedAgents && !working ? (
				<StartForm busy={busy} onStart={(count, minutes) => act(() => startHostedAgents(repo, count, minutes))} />
			) : null}
			{stopHostedAgents && working ? (
				<div className="border-t border-border px-0.5 py-3">
					<Button onClick={() => act(() => stopHostedAgents(repo))} disabled={busy}>
						Stop them
					</Button>
				</div>
			) : null}
		</Box>
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
	return <p className={LINE}>{hiveWords(status)}</p>;
}
