import { useState } from "react";
import type { AccountApi, Connection, IssuedToken, Me, MyAgent } from "../api";
import { useArrivals } from "../hooks/useArrivals";
import { useChanged } from "../hooks/useChanged";
import { usePoll } from "../hooks/usePoll";
import { timeAgo } from "../lib/relativeTime";
import { DEFAULT_TOKEN_DAYS, MCP_CLIENTS, type McpClient } from "../lib/session";
import { cn } from "../lib/utils";
import { type RunAction, useRowActions } from "../hooks/useRowActions";
import { AgentRow, type RowShared } from "./AgentRow";
import { ConfirmButton } from "./Confirm";
import { ConnectSection, rememberClient, rememberedClient } from "./AgentsConnect";
import { Page } from "./Page";
import { Box, BoxHeader, Callout } from "./ui/box";
import { Button } from "./ui/button";
import { Input } from "./ui/field";
import { ROWS } from "./ui/manage";

// A box's own line in place of its rows: that they're loading, or that there are none, with a paragraph's margins.
const LINE = "my-3.75 px-0.5 py-4 text-muted-foreground";
// A box's title on this page.
const TITLE = "text-body-sm";

type User = Extract<Me, { kind: "user" }>;

/** What the page does. Each call resolves once the server agrees, or throws its error. */
export interface AgentActions {
	createAgent(name: string): Promise<unknown>;
	revokeAgent(id: string): Promise<unknown>;
	createToken(agentId: string, expiresInDays: number | null): Promise<IssuedToken>;
	revokeToken(id: string): Promise<unknown>;
	disconnect(id: string): Promise<unknown>;
}

type Issued = { agentId: string; token: string };

/** The Agents page as it looks: how to connect, your agents and their tokens, and connected apps. */
export function AgentsView({
	me,
	origin,
	agents,
	connections,
	error,
	actions,
	initialIssued = null,
	now = Date.now(),
}: {
	me: User;
	origin: string;
	agents: MyAgent[] | undefined;
	connections: Connection[] | undefined;
	error?: string;
	actions: AgentActions;
	/** A token just made, shown once (tests start with one). */
	initialIssued?: Issued | null;
	now?: number;
}) {
	const { run, busy, confirming, setConfirming, failed: showError, errorText: errorFor } = useRowActions();
	const [expiry, setExpiry] = useState<Record<string, number | null>>({});
	const [issued, setIssued] = useState<Issued | null>(initialIssued);
	const { client, chooseClient, clientLabel, yourClient } = useChosenClient();
	/** The apps connected as an agent over OAuth, each named once. */
	const signsInFrom = (agentId: string) => {
		const own = (connections ?? []).filter((connection) => connection.agentId === agentId);
		return [...new Set(own.map((connection) => connection.client))];
	};
	const daysFor = (agentId: string) => {
		const chosen = expiry[agentId];
		return chosen === undefined ? DEFAULT_TOKEN_DAYS : chosen;
	};
	const shared: RowShared = { actions, run, busy, confirming, setConfirming, now };

	const agentRow = (agent: MyAgent, arrived: boolean) => (
		<AgentRow
			key={agent.id}
			arrived={arrived}
			{...shared}
			agent={agent}
			fullName={`${me.handle}/${agent.name}`}
			days={daysFor(agent.id)}
			chooseDays={(days) => setExpiry({ ...expiry, [agent.id]: days })}
			issued={issued?.agentId === agent.id ? issued.token : null}
			setIssued={(token) => setIssued(token === null ? null : { agentId: agent.id, token })}
			error={errorFor(agent.id)}
			setError={showError(agent.id)}
			signsInFrom={signsInFrom(agent.id)}
			client={client}
			origin={origin}
		/>
	);

	return (
		<Page id="main" className="grid gap-4">
			<header>
				<h1 className="mb-1.5 text-display-sm tracking-[-0.01em]">Agents</h1>
				<p className="m-0 text-muted-foreground">
					Agents act for you in GitHive. Each has its own name, like <code>{me.handle}/builder</code>, and what it
					writes is attributed to it, under you.
				</p>
			</header>

			{error ? (
				<Callout tone="bad" className="animate-appear" role="alert">
					<p>{error}</p>
				</Callout>
			) : null}

			<ConnectSection
				client={client}
				chooseClient={chooseClient}
				origin={origin}
				yourClient={yourClient}
				clientLabel={clientLabel}
			/>

			<Box aria-labelledby="agents-title">
				<NewAgentForm handle={me.handle} create={(name) => actions.createAgent(name)} run={run} busy={busy} />
				<AgentList agents={agents} yourClient={yourClient} agentRow={agentRow} />
			</Box>

			<Box aria-labelledby="apps-title">
				<BoxHeader>
					<h2 id="apps-title" className={TITLE}>
						Connected apps
					</h2>
				</BoxHeader>
				<ConnectedApps connections={connections} {...shared} errorFor={errorFor} showError={showError} />
			</Box>
		</Page>
	);
}

/** The MCP client the page explains setup for, remembered for the next visit. */
function useChosenClient() {
	const [client, setClient] = useState<McpClient>(rememberedClient);
	const chooseClient = (next: McpClient) => {
		setClient(next);
		rememberClient(next);
	};
	const clientLabel = MCP_CLIENTS.find((option) => option.id === client)!.label;
	const yourClient = client === "other" ? "your client" : clientLabel;
	return { client, chooseClient, clientLabel, yourClient };
}

/** Names and makes a new agent under your handle. Its error shows under the list's header. */
function NewAgentForm(props: {
	handle: string;
	create: (name: string) => Promise<unknown>;
	run: RunAction;
	busy: string | null;
}) {
	const { handle, create, run, busy } = props;
	const [newName, setNewName] = useState("");
	const [createError, setCreateError] = useState<string | null>(null);
	const submit = async (event: React.FormEvent) => {
		event.preventDefault();
		setCreateError(null);
		const ok = await run("create", () => create(newName.trim()), setCreateError);
		if (ok) setNewName("");
	};
	return (
		<>
			<BoxHeader className="justify-between">
				<h2 id="agents-title" className={TITLE}>
					Your agents
				</h2>
				<form className="flex min-w-0 flex-wrap items-center gap-1.5" onSubmit={submit}>
					<label htmlFor="new-agent-name" className="sr-only">
						New agent's name
					</label>
					<span className="font-mono text-meta text-muted-foreground" aria-hidden="true">
						{handle}/
					</span>
					<Input
						id="new-agent-name"
						className="w-40 font-mono text-meta leading-[inherit]"
						value={newName}
						onChange={(event) => setNewName(event.target.value)}
						placeholder="builder"
						autoComplete="off"
						spellCheck={false}
					/>
					<Button type="submit" variant="primary" size="sm" disabled={busy !== null || !newName.trim()}>
						{busy === "create" ? "Making…" : "New agent"}
					</Button>
				</form>
			</BoxHeader>
			{createError ? (
				<p className="m-0 animate-appear px-4 pt-2.5 text-bad" role="alert">
					{createError}
				</p>
			) : null}
		</>
	);
}

/** Your agents, active ones first; or that they're loading, or that there are none. */
function AgentList({
	agents,
	yourClient,
	agentRow,
}: {
	agents: MyAgent[] | undefined;
	yourClient: string;
	agentRow: (agent: MyAgent, arrived: boolean) => React.ReactNode;
}) {
	// What's read fades in as it takes the place of "Loading…"; an agent made later fades in on its own.
	const read = useChanged(agents === undefined) && "animate-appear";
	const arrived = useArrivals((agents ?? []).map((agent) => agent.id));
	if (agents === undefined)
		return (
			<p className={LINE} role="status">
				Loading your agents…
			</p>
		);
	if (agents.length === 0)
		return (
			<div className={cn("px-0.5 py-4", read)}>
				<p className="m-0 text-muted-foreground">
					No agents yet. Name one above, or connect {yourClient} and name it while you sign in.
				</p>
			</div>
		);
	const live = agents.filter((agent) => !agent.revokedAt);
	const revoked = agents.filter((agent) => agent.revokedAt);
	return <ul className={ROWS}>{[...live, ...revoked].map((agent) => agentRow(agent, arrived(agent.id)))}</ul>;
}

interface ConnectedAppsProps extends RowShared {
	connections: Connection[] | undefined;
	errorFor: (id: string) => string | null;
	showError: (id: string) => (text: string) => void;
}

/** The apps connected over OAuth, each to disconnect. */
function ConnectedApps({
	connections,
	errorFor,
	showError,
	actions,
	run,
	busy,
	confirming,
	setConfirming,
	now,
}: ConnectedAppsProps) {
	// What's read fades in as it takes the place of "Loading…"; an app connected later fades in on its own.
	const read = useChanged(connections === undefined) && "animate-appear";
	const arrived = useArrivals((connections ?? []).map((connection) => connection.id));
	if (connections === undefined)
		return (
			<p className={LINE} role="status">
				Loading…
			</p>
		);
	if (connections.length === 0) return <p className={cn(LINE, read)}>No apps connected over OAuth yet.</p>;
	return (
		<ul className={ROWS}>
			{connections.map((connection) => {
				const key = `conn:${connection.id}`;
				const error = errorFor(connection.id);
				return (
					<li
						key={connection.id}
						className={cn(
							"flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t border-border px-4 py-3 first:border-t-0",
							arrived(connection.id) && "animate-appear",
						)}
					>
						<div className="min-w-0 wrap-anywhere">
							<strong>{connection.client}</strong> <span className="text-muted-foreground">as</span>{" "}
							<code>{connection.agent ?? "an agent"}</code>
							<span className="text-meta text-muted-foreground"> · connected {timeAgo(connection.createdAt, now)}</span>
						</div>
						<ConfirmButton
							id={key}
							confirming={confirming}
							setConfirming={setConfirming}
							label="Disconnect"
							question={`Disconnect ${connection.client}?`}
							busy={busy === key}
							onConfirm={() => run(key, () => actions.disconnect(connection.id), showError(connection.id))}
						/>
						{error !== null ? (
							<p className="m-0 animate-appear text-bad" role="alert">
								{error}
							</p>
						) : null}
					</li>
				);
			})}
		</ul>
	);
}

/** The Agents page: loads your agents and connected apps, and refreshes them after each action. */
export function AgentsPage({ me, account }: { me: User; account: AccountApi }) {
	const agents = usePoll("me:agents", account.agents, 60_000);
	const connections = usePoll("me:connections", account.connections, 60_000);
	const refreshAfter =
		<Args extends unknown[], Result>(work: (...args: Args) => Promise<Result>) =>
		async (...args: Args) => {
			const result = await work(...args);
			agents.refresh();
			connections.refresh();
			return result;
		};
	const actions: AgentActions = {
		createAgent: refreshAfter(account.createAgent),
		revokeAgent: refreshAfter(account.revokeAgent),
		createToken: refreshAfter(account.createToken),
		revokeToken: refreshAfter(account.revokeToken),
		disconnect: refreshAfter(account.disconnect),
	};
	return (
		<AgentsView
			me={me}
			origin={window.location.origin}
			agents={agents.data}
			connections={connections.data}
			error={agents.error ?? connections.error}
			actions={actions}
		/>
	);
}
