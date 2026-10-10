import { useState } from "react";
import type { AccountApi, Connection, IssuedToken, Me, MyAgent } from "../api";
import { usePoll } from "../hooks/usePoll";
import { timeAgo } from "../lib/relativeTime";
import {
	type ConnectStep,
	DEFAULT_TOKEN_DAYS,
	MCP_CLIENTS,
	type McpClient,
	TOKEN_EXPIRY,
	connectSteps,
	expiryDate,
	expiryFromValue,
	expiryValue,
	isMcpClient,
	tokenLabel,
	tokenSteps,
} from "../lib/session";
import { CopyBlock } from "./CopyBlock";
import { Icon } from "./Icon";
import "./AgentsPage.css";

type User = Extract<Me, { kind: "user" }>;

/** What the page does: each call resolves once the server agrees, or throws its error. */
export interface AgentActions {
	createAgent(name: string): Promise<unknown>;
	revokeAgent(id: string): Promise<unknown>;
	createToken(agentId: string, expiresInDays: number | null): Promise<IssuedToken>;
	revokeToken(id: string): Promise<unknown>;
	disconnect(id: string): Promise<unknown>;
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** A "Revoke" that asks once more, in the page. */
function ConfirmButton({
	id,
	confirming,
	setConfirming,
	label,
	question,
	busy,
	onConfirm,
}: {
	id: string;
	confirming: string | null;
	setConfirming: (id: string | null) => void;
	label: string;
	question: string;
	busy: boolean;
	onConfirm: () => void;
}) {
	if (confirming !== id)
		return (
			<button type="button" className="danger agents__small" onClick={() => setConfirming(id)} disabled={busy}>
				{label}
			</button>
		);
	return (
		<span className="agents__confirm" role="group" aria-label={question}>
			<span>{question}</span>
			<button type="button" className="danger agents__small" onClick={onConfirm} disabled={busy}>
				{busy ? "Working…" : `Yes, ${label.toLowerCase()}`}
			</button>
			<button type="button" className="agents__small" onClick={() => setConfirming(null)} disabled={busy}>
				Cancel
			</button>
		</span>
	);
}

/** The Agents page as it looks: how to connect, your agents and their tokens, and connected apps. */
const CLIENT_KEY = "githive:mcp-client";
/** The client chosen last time, in this browser; Claude Code at first. */
function rememberedClient(): McpClient {
	try {
		const saved = localStorage.getItem(CLIENT_KEY);
		return isMcpClient(saved) ? saved : "claude-code";
	} catch {
		return "claude-code";
	}
}
function rememberClient(client: McpClient) {
	try {
		localStorage.setItem(CLIENT_KEY, client);
	} catch {
		// Only a convenience: without storage the choice lasts as long as the page.
	}
}

/** Text with `code` in backticks. */
function WithCode({ text }: { text: string }) {
	return <>{text.split("`").map((part, i) => (i % 2 ? <code key={i}>{part}</code> : <span key={i}>{part}</span>))}</>;
}

/** Numbered steps, each with what to copy. */
function Steps({ steps }: { steps: ConnectStep[] }) {
	return (
		<ol className="agents__steps">
			{steps.map((step, i) => (
				<li key={i}>
					<WithCode text={step.text} />
					{step.copy ? <CopyBlock text={step.copy} /> : null}
				</li>
			))}
		</ol>
	);
}

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
	initialIssued?: { agentId: string; token: string } | null;
	now?: number;
}) {
	const [newName, setNewName] = useState("");
	const [createError, setCreateError] = useState<string | null>(null);
	const [rowError, setRowError] = useState<{ id: string; text: string } | null>(null);
	const [confirming, setConfirming] = useState<string | null>(null);
	const [busy, setBusy] = useState<string | null>(null);
	const [expiry, setExpiry] = useState<Record<string, number | null>>({});
	const [issued, setIssued] = useState<{ agentId: string; token: string } | null>(initialIssued);
	const [client, setClient] = useState<McpClient>(rememberedClient);
	const chooseClient = (next: McpClient) => {
		setClient(next);
		rememberClient(next);
	};
	const clientLabel = MCP_CLIENTS.find((c) => c.id === client)!.label;
	/** The apps connected as an agent over OAuth, each named once. */
	const signsInFrom = (agentId: string) => [
		...new Set((connections ?? []).filter((c) => c.agentId === agentId).map((c) => c.client)),
	];

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

	const create = async (event: React.FormEvent) => {
		event.preventDefault();
		setCreateError(null);
		if (await run("create", () => actions.createAgent(newName.trim()), setCreateError)) setNewName("");
	};

	const live = (agents ?? []).filter((a) => !a.revokedAt);
	const revoked = (agents ?? []).filter((a) => a.revokedAt);

	const agentRow = (agent: MyAgent) => {
		const full = `${me.handle}/${agent.name}`;
		const active = !agent.revokedAt;
		const days = expiry[agent.id] === undefined ? DEFAULT_TOKEN_DAYS : expiry[agent.id];
		const shown = issued?.agentId === agent.id ? issued.token : null;
		return (
			<li key={agent.id} className={`agents__agent${active ? "" : " agents__agent--revoked"}`}>
				<div className="agents__agent-head">
					<div className="agents__agent-name">
						<Icon name="bot" size={16} />
						<code>{full}</code>
						{active ? (
							<span className="pill pill--good">Active</span>
						) : (
							<span className="pill pill--neutral">Revoked</span>
						)}
						<span className="muted agents__meta">made {timeAgo(agent.createdAt, now)}</span>
					</div>
					{active ? (
						<div className="agents__agent-actions">
							<label className="agents__expiry">
								<span className="sr-only">New token for {full} lasts</span>
								<select
									id={`expiry-${agent.id}`}
									value={expiryValue(days)}
									onChange={(e) => setExpiry({ ...expiry, [agent.id]: expiryFromValue(e.target.value) })}
								>
									{TOKEN_EXPIRY.map((choice) => (
										<option key={expiryValue(choice.days)} value={expiryValue(choice.days)}>
											{choice.days === null ? "Never expires" : `Expires in ${choice.label}`}
										</option>
									))}
								</select>
							</label>
							<button
								type="button"
								className="accent agents__small"
								disabled={busy !== null}
								onClick={() =>
									run(
										`token:${agent.id}`,
										async () =>
											setIssued({ agentId: agent.id, token: (await actions.createToken(agent.id, days)).token }),
										(text) => setRowError({ id: agent.id, text }),
									)
								}
							>
								{busy === `token:${agent.id}` ? "Making…" : "New token"}
							</button>
							<ConfirmButton
								id={`agent:${agent.id}`}
								confirming={confirming}
								setConfirming={setConfirming}
								label="Revoke"
								question={`Revoke ${full}, its tokens and connected apps?`}
								busy={busy === `agent:${agent.id}`}
								onConfirm={() =>
									run(
										`agent:${agent.id}`,
										() => actions.revokeAgent(agent.id),
										(text) => setRowError({ id: agent.id, text }),
									)
								}
							/>
						</div>
					) : null}
				</div>
				{rowError?.id === agent.id ? (
					<p className="error agents__row-error" role="alert">
						{rowError.text}
					</p>
				) : null}
				{shown ? (
					<div className="callout callout--good agents__issued" role="status">
						<div className="agents__issued-body">
							<p>
								<strong>New token for {full}.</strong> Copy it now: you won't see it again.
							</p>
							<CopyBlock text={shown} label="Copy token" />
							<Steps steps={tokenSteps(client, origin, shown)} />
							<button type="button" className="agents__small" onClick={() => setIssued(null)}>
								Done
							</button>
						</div>
					</div>
				) : null}
				{agent.tokens.length > 0 ? (
					<ul className="agents__tokens">
						{agent.tokens.map((token) => (
							<li key={token.id} className={`agents__token${token.revokedAt ? " agents__token--revoked" : ""}`}>
								<code>{tokenLabel(token.prefix)}</code>
								<span className="muted agents__meta">
									made {timeAgo(token.createdAt, now)} ·{" "}
									{token.expiresAt ? `expires ${expiryDate(token.expiresAt)}` : "never expires"} ·{" "}
									{token.lastUsedAt ? `used ${timeAgo(token.lastUsedAt, now)}` : "never used"}
								</span>
								{token.revokedAt ? (
									<span className="pill pill--neutral">Revoked</span>
								) : token.expiresAt && Date.parse(token.expiresAt) <= now ? (
									<span className="pill pill--neutral">Expired</span>
								) : active ? (
									<ConfirmButton
										id={`token:${token.id}`}
										confirming={confirming}
										setConfirming={setConfirming}
										label="Revoke"
										question="Revoke this token?"
										busy={busy === `token:${token.id}`}
										onConfirm={() =>
											run(
												`token:${token.id}`,
												() => actions.revokeToken(token.id),
												(text) => setRowError({ id: agent.id, text }),
											)
										}
									/>
								) : null}
							</li>
						))}
					</ul>
				) : active ? (
					<p className="muted agents__none">
						{signsInFrom(agent.id).length
							? `Signs in from ${signsInFrom(agent.id).join(" and ")}, so it needs no token.`
							: "No tokens yet."}
					</p>
				) : null}
			</li>
		);
	};

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

			<section className="agents__connect" aria-labelledby="connect-title">
				<h2 id="connect-title">Connect an agent</h2>
				<div className="agents__clients" role="radiogroup" aria-label="Your agent's app">
					{MCP_CLIENTS.map((c) => (
						<label key={c.id} className={`agents__client${client === c.id ? " is-selected" : ""}`}>
							<input
								type="radio"
								name="mcp-client"
								value={c.id}
								checked={client === c.id}
								onChange={() => chooseClient(c.id)}
							/>
							{c.label}
						</label>
					))}
				</div>
				<div className="agents__ways">
					<div className="box agents__way">
						<div className="box__body">
							<h3>
								Sign in from {client === "other" ? "the client" : clientLabel}{" "}
								<span className="pill pill--accent">Recommended</span>
							</h3>
							<Steps steps={connectSteps(client, origin)} />
						</div>
					</div>
					<div className="box agents__way">
						<div className="box__body">
							<h3>Or use a token</h3>
							<p className="muted">
								For a client that can't sign in through your browser. Make an agent below and choose New token. GitHive
								shows the token once, with the setup for {client === "other" ? "your client" : clientLabel} filled in,
								ready to copy.
							</p>
						</div>
					</div>
				</div>
			</section>

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
							onChange={(e) => setNewName(e.target.value)}
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
				{agents === undefined ? (
					<p className="muted box__body" role="status">
						Loading your agents…
					</p>
				) : agents.length === 0 ? (
					<div className="box__body agents__empty">
						<p>
							No agents yet. Name one above, or connect {client === "other" ? "your client" : clientLabel} and name it
							while you sign in.
						</p>
					</div>
				) : (
					<ul className="agents__agents">{[...live, ...revoked].map(agentRow)}</ul>
				)}
			</section>

			<section className="box agents__apps" aria-labelledby="apps-title">
				<div className="box__header">
					<h2 id="apps-title">Connected apps</h2>
				</div>
				{connections === undefined ? (
					<p className="muted box__body" role="status">
						Loading…
					</p>
				) : connections.length === 0 ? (
					<p className="muted box__body">No apps connected over OAuth yet.</p>
				) : (
					<ul className="agents__connections">
						{connections.map((c) => (
							<li key={c.id} className="agents__connection">
								<div>
									<strong>{c.client}</strong> <span className="muted">as</span> <code>{c.agent ?? "an agent"}</code>
									<span className="muted agents__meta"> · connected {timeAgo(c.createdAt, now)}</span>
								</div>
								<ConfirmButton
									id={`conn:${c.id}`}
									confirming={confirming}
									setConfirming={setConfirming}
									label="Disconnect"
									question={`Disconnect ${c.client}?`}
									busy={busy === `conn:${c.id}`}
									onConfirm={() =>
										run(
											`conn:${c.id}`,
											() => actions.disconnect(c.id),
											(text) => setRowError({ id: c.id, text }),
										)
									}
								/>
								{rowError?.id === c.id ? (
									<p className="error agents__row-error" role="alert">
										{rowError.text}
									</p>
								) : null}
							</li>
						))}
					</ul>
				)}
			</section>
		</main>
	);
}

/** The Agents page: loads your agents and connected apps, and refreshes them after each action. */
export function AgentsPage({ me, account }: { me: User; account: AccountApi }) {
	const agents = usePoll("me:agents", account.agents, 60_000);
	const connections = usePoll("me:connections", account.connections, 60_000);
	const after =
		<A extends unknown[], R>(work: (...args: A) => Promise<R>) =>
		async (...args: A) => {
			const result = await work(...args);
			agents.refresh();
			connections.refresh();
			return result;
		};
	const actions: AgentActions = {
		createAgent: after(account.createAgent),
		revokeAgent: after(account.revokeAgent),
		createToken: after(account.createToken),
		revokeToken: after(account.revokeToken),
		disconnect: after(account.disconnect),
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
