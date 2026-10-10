import { useState } from "react";
import type { AccountApi, Connection, IssuedToken, Me, MyAgent } from "../api";
import { usePoll } from "../hooks/usePoll";
import { timeAgo } from "../lib/relativeTime";
import { DEFAULT_TOKEN_DAYS, MCP_CLIENTS, type McpClient } from "../lib/session";
import { AgentRow, ConfirmButton, type RowShared } from "./AgentRow";
import { ConnectSection, rememberClient, rememberedClient } from "./AgentsConnect";
import "./AgentsPage.css";

type User = Extract<Me, { kind: "user" }>;

/** What the page does. Each call resolves once the server agrees, or throws its error. */
export interface AgentActions {
	createAgent(name: string): Promise<unknown>;
	revokeAgent(id: string): Promise<unknown>;
	createToken(agentId: string, expiresInDays: number | null): Promise<IssuedToken>;
	revokeToken(id: string): Promise<unknown>;
	disconnect(id: string): Promise<unknown>;
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

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
	const [newName, setNewName] = useState("");
	const [createError, setCreateError] = useState<string | null>(null);
	const [rowError, setRowError] = useState<{ id: string; text: string } | null>(null);
	const [confirming, setConfirming] = useState<string | null>(null);
	const [busy, setBusy] = useState<string | null>(null);
	const [expiry, setExpiry] = useState<Record<string, number | null>>({});
	const [issued, setIssued] = useState<Issued | null>(initialIssued);
	const [client, setClient] = useState<McpClient>(rememberedClient);
	const chooseClient = (next: McpClient) => {
		setClient(next);
		rememberClient(next);
	};
	const clientLabel = MCP_CLIENTS.find((option) => option.id === client)!.label;
	const yourClient = client === "other" ? "your client" : clientLabel;
	/** The apps connected as an agent over OAuth, each named once. */
	const signsInFrom = (agentId: string) => {
		const own = (connections ?? []).filter((connection) => connection.agentId === agentId);
		return [...new Set(own.map((connection) => connection.client))];
	};
	const daysFor = (agentId: string) => {
		const chosen = expiry[agentId];
		return chosen === undefined ? DEFAULT_TOKEN_DAYS : chosen;
	};
	const errorFor = (id: string) => (rowError?.id === id ? rowError.text : null);
	const showError = (id: string) => (text: string) => setRowError({ id, text });

	const run = async (key: string, work: () => Promise<unknown>, onError: (text: string) => void) => {
		setBusy(key);
		try {
			await work();
			setConfirming(null);
			return true;
		} catch (err) {
			onError(message(err));
			return false;
		} finally {
			setBusy(null);
		}
	};
	const shared: RowShared = { actions, run, busy, confirming, setConfirming, now };

	const create = async (event: React.FormEvent) => {
		event.preventDefault();
		setCreateError(null);
		const ok = await run("create", () => actions.createAgent(newName.trim()), setCreateError);
		if (ok) setNewName("");
	};

	const agentRow = (agent: MyAgent) => (
		<AgentRow
			key={agent.id}
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
		<main className="page agents" id="main">
			<header className="agents__header">
				<h1>Agents</h1>
				<p className="muted">
					Agents act for you in GitHive. Each has its own name, like <code>{me.handle}/builder</code>, and what it
					writes is attributed to it, under you.
				</p>
			</header>

			{error ? (
				<div className="callout callout--bad" role="alert">
					<p>{error}</p>
				</div>
			) : null}

			<ConnectSection
				client={client}
				chooseClient={chooseClient}
				origin={origin}
				yourClient={yourClient}
				clientLabel={clientLabel}
			/>

			<section className="box agents__list" aria-labelledby="agents-title">
				<div className="box__header agents__list-header">
					<h2 id="agents-title">Your agents</h2>
					<form className="agents__new" onSubmit={create}>
						<label htmlFor="new-agent-name" className="sr-only">
							New agent's name
						</label>
						<span className="agents__new-prefix" aria-hidden="true">
							{me.handle}/
						</span>
						<input
							id="new-agent-name"
							value={newName}
							onChange={(event) => setNewName(event.target.value)}
							placeholder="builder"
							autoComplete="off"
							spellCheck={false}
						/>
						<button type="submit" className="accent agents__small" disabled={busy !== null || !newName.trim()}>
							{busy === "create" ? "Making…" : "New agent"}
						</button>
					</form>
				</div>
				{createError ? (
					<p className="error agents__create-error" role="alert">
						{createError}
					</p>
				) : null}
				<AgentList agents={agents} yourClient={yourClient} agentRow={agentRow} />
			</section>

			<section className="box agents__apps" aria-labelledby="apps-title">
				<div className="box__header">
					<h2 id="apps-title">Connected apps</h2>
				</div>
				<ConnectedApps connections={connections} {...shared} errorFor={errorFor} showError={showError} />
			</section>
		</main>
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
	agentRow: (agent: MyAgent) => React.ReactNode;
}) {
	if (agents === undefined)
		return (
			<p className="muted box__body" role="status">
				Loading your agents…
			</p>
		);
	if (agents.length === 0)
		return (
			<div className="box__body agents__empty">
				<p>No agents yet. Name one above, or connect {yourClient} and name it while you sign in.</p>
			</div>
		);
	const live = agents.filter((agent) => !agent.revokedAt);
	const revoked = agents.filter((agent) => agent.revokedAt);
	return <ul className="agents__agents">{[...live, ...revoked].map(agentRow)}</ul>;
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
	if (connections === undefined)
		return (
			<p className="muted box__body" role="status">
				Loading…
			</p>
		);
	if (connections.length === 0) return <p className="muted box__body">No apps connected over OAuth yet.</p>;
	return (
		<ul className="agents__connections">
			{connections.map((connection) => {
				const key = `conn:${connection.id}`;
				const error = errorFor(connection.id);
				return (
					<li key={connection.id} className="agents__connection">
						<div>
							<strong>{connection.client}</strong> <span className="muted">as</span>{" "}
							<code>{connection.agent ?? "an agent"}</code>
							<span className="muted agents__meta"> · connected {timeAgo(connection.createdAt, now)}</span>
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
							<p className="error agents__row-error" role="alert">
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
