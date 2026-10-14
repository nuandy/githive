import { useState } from "react";
import type { AccountApi, AgentLimits, Connection, IssuedToken, Me, MyAgent } from "../api";
import { useArrivals } from "../hooks/useArrivals";
import { useChanged } from "../hooks/useChanged";
import { useConnectionWatch } from "../hooks/useConnectionWatch";
import { usePoll } from "../hooks/usePoll";
import { type RunAction, useRowActions } from "../hooks/useRowActions";
import { useStagger } from "../hooks/useStagger";
import { connectionsOf, otherConnections, whenWords } from "../lib/myAgents";
import { MCP_CLIENTS, type McpClient } from "../lib/session";
import { cn } from "../lib/utils";
import { AgentCard, RevokedAgent, type RowShared } from "./AgentRow";
import { ConnectSection, rememberClient, rememberedClient } from "./AgentsConnect";
import { ConfirmButton } from "./Confirm";
import { Page, PageHeader } from "./Page";
import { Box, BoxHeader, BoxTitle, Callout } from "./ui/box";
import { Button } from "./ui/button";
import { Input } from "./ui/field";
import { ROWS } from "./ui/manage";

// A box's own line in place of its rows: that they're loading, or that there are none, with a paragraph's margins.
const LINE = "my-3.75 px-0.5 py-4 text-muted-foreground";

type User = Extract<Me, { kind: "user" }>;

/** What the page does. Each call resolves once the server agrees, or throws its error. */
export interface AgentActions {
	createAgent(name: string): Promise<unknown>;
	revokeAgent(id: string): Promise<unknown>;
	setLimits(id: string, limits: Partial<AgentLimits>): Promise<unknown>;
	createToken(agentId: string, expiresInDays: number | null): Promise<IssuedToken>;
	revokeToken(id: string): Promise<unknown>;
	disconnect(id: string): Promise<unknown>;
}

/**
 * Your agents, as the page shows them: how to connect one and what to ask it, then each agent in a card (its state,
 * the apps it signs in from, its limits and its tokens), the revoked ones folded away, and any app tied to none.
 */
export function AgentsView({
	me,
	origin,
	agents,
	connections,
	repos,
	error,
	actions,
	readConnections,
	onConnected,
	now = Date.now(),
}: {
	me: User;
	origin: string;
	agents: MyAgent[] | undefined;
	connections: Connection[] | undefined;
	/** Your repositories, most recently active first; undefined while loading. */
	repos?: string[] | undefined;
	error?: string;
	actions: AgentActions;
	/** Reads the connections again: looked at every few seconds after a command that connects is copied. */
	readConnections?: () => Promise<Connection[]>;
	/** A new connection came while looking. */
	onConnected?: () => void;
	now?: number;
}) {
	const { run, busy, confirming, setConfirming, failed: showError, errorText: errorFor } = useRowActions();
	const { client, chooseClient, clientLabel, yourClient } = useChosenClient();
	const watch = useConnectionWatch(readConnections, connections, onConnected);
	const shared: RowShared = { actions, run, busy, confirming, setConfirming, now };
	const others = agents && connections ? otherConnections(agents, connections) : [];

	const agentCard = (agent: MyAgent, arrived: boolean) => (
		<AgentCard
			key={agent.id}
			arrived={arrived}
			{...shared}
			agent={agent}
			fullName={`${me.handle}/${agent.name}`}
			apps={connectionsOf(agent.id, connections ?? [])}
			error={errorFor(agent.id)}
			setError={showError(agent.id)}
			client={client}
			origin={origin}
		/>
	);

	return (
		<Page className="grid gap-4">
			<PageHeader
				className="mb-0"
				title="Your agents"
				description={
					<>
						Agents act for you in GitHive. Each has its own name, like <code>{me.handle}/builder</code>, and what it
						writes is attributed to it, under you.
					</>
				}
			/>

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
				repos={repos}
				watch={watch.state}
				onCopied={() => void watch.start()}
			/>

			<Box aria-labelledby="agents-title">
				<NewAgentForm handle={me.handle} create={(name) => actions.createAgent(name)} run={run} busy={busy} />
				<AgentList agents={agents} yourClient={yourClient} agentCard={agentCard} handle={me.handle} now={now} />
			</Box>

			{others.length ? (
				<Box aria-labelledby="apps-title">
					<BoxHeader>
						<BoxTitle id="apps-title">Other connected apps</BoxTitle>
					</BoxHeader>
					<OtherApps connections={others} {...shared} errorFor={errorFor} showError={showError} />
				</Box>
			) : null}
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

/** Names and makes a new agent under your handle. Its error shows under the box's header, tied to the name. */
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
				<BoxTitle id="agents-title">Agents</BoxTitle>
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
						onChange={(event) => {
							setNewName(event.target.value);
							setCreateError(null);
						}}
						placeholder="builder"
						autoComplete="off"
						spellCheck={false}
						{...(createError ? { "aria-invalid": true, "aria-describedby": "new-agent-error" } : {})}
					/>
					<Button type="submit" variant="primary" size="sm" disabled={busy !== null || !newName.trim()}>
						{busy === "create" ? "Making…" : "New agent"}
					</Button>
				</form>
			</BoxHeader>
			{createError ? (
				<p id="new-agent-error" className="m-0 animate-appear px-0.5 pt-2.5 text-bad" role="alert">
					{createError}
				</p>
			) : null}
		</>
	);
}

/** Your agents, each in its card; the revoked ones folded away under how many; or that they're loading, or none. */
function AgentList({
	agents,
	yourClient,
	agentCard,
	handle,
	now,
}: {
	agents: MyAgent[] | undefined;
	yourClient: string;
	agentCard: (agent: MyAgent, arrived: boolean) => React.ReactNode;
	handle: string;
	now: number;
}) {
	// What's read fades in as it takes the place of "Loading…"; an agent made later fades in on its own.
	const read = useChanged(agents === undefined) && "animate-fade";
	const arrived = useArrivals((agents ?? []).map((agent) => agent.id));
	const staggers = useStagger(!!agents?.length);
	if (agents === undefined)
		return (
			<p className={LINE} role="status">
				Loading your agents…
			</p>
		);
	const live = agents.filter((agent) => !agent.revokedAt);
	const revoked = agents.filter((agent) => agent.revokedAt);
	return (
		<>
			{live.length ? (
				<ul className={cn(ROWS, staggers && "stagger")}>{live.map((agent) => agentCard(agent, arrived(agent.id)))}</ul>
			) : revoked.length ? (
				<p className={cn(LINE, read)}>No active agents. Name one above, or bring back a revoked one.</p>
			) : (
				<p className={cn(LINE, read)}>
					No agents yet. Name one above, or connect {yourClient} and name it while you sign in.
				</p>
			)}
			{revoked.length ? (
				<details className="disclosure border-t border-border">
					<summary className="w-fit cursor-pointer px-0.5 py-3 text-ui font-medium text-muted-foreground">
						Revoked ({revoked.length})
					</summary>
					<p className="mt-0 mb-2 px-0.5 text-meta text-muted-foreground">
						Name one of these again above to bring it back, with new tokens; its work stays under its name.
					</p>
					<ul className={ROWS}>
						{revoked.map((agent) => (
							<RevokedAgent key={agent.id} agent={agent} fullName={`${handle}/${agent.name}`} now={now} />
						))}
					</ul>
				</details>
			) : null}
		</>
	);
}

interface OtherAppsProps extends RowShared {
	connections: Connection[];
	errorFor: (id: string) => string | null;
	showError: (id: string) => (text: string) => void;
}

/** Apps connected over OAuth that act as none of the agents listed: each to disconnect. */
function OtherApps(props: OtherAppsProps) {
	const { connections, errorFor, showError, actions, run, busy, confirming, setConfirming, now } = props;
	const arrived = useArrivals(connections.map((connection) => connection.id));
	return (
		<ul className={ROWS}>
			{connections.map((connection) => {
				const key = `conn:${connection.id}`;
				const error = errorFor(connection.id);
				return (
					<li
						key={connection.id}
						className={cn(
							"flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t border-border px-0.5 py-3 first:border-t-0",
							arrived(connection.id) && "animate-appear",
						)}
					>
						<div className="min-w-0 wrap-anywhere">
							<strong>{connection.client}</strong> <span className="text-muted-foreground">as</span>{" "}
							<code>{connection.agent ?? "no agent"}</code>
							<span className="text-meta text-muted-foreground">
								{" "}
								· connected {whenWords(connection.createdAt, now)}
							</span>
						</div>
						<ConfirmButton
							id={key}
							confirming={confirming}
							setConfirming={setConfirming}
							label="Disconnect"
							question={`Disconnect ${connection.client}? It stops acting as ${connection.agent ?? "your agent"} until it signs in again.`}
							keep={`Keep ${connection.client}`}
							busy={busy === key}
							onConfirm={() => run(key, () => actions.disconnect(connection.id), showError(connection.id))}
						/>
						{error !== null ? (
							<p className="m-0 basis-full animate-appear text-bad" role="alert">
								{error}
							</p>
						) : null}
					</li>
				);
			})}
		</ul>
	);
}

/** Your agents: loads them and the apps connected as them, and refreshes both after each action. */
export function AgentsPage({ me, account, repos }: { me: User; account: AccountApi; repos?: string[] | undefined }) {
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
		setLimits: refreshAfter(account.setLimits),
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
			repos={repos}
			error={agents.error ?? connections.error}
			actions={actions}
			readConnections={account.connections}
			onConnected={() => {
				agents.refresh();
				connections.refresh();
			}}
		/>
	);
}
