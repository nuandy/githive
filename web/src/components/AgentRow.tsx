import type { MyAgent } from "../api";
import { timeAgo } from "../lib/relativeTime";
import {
	type McpClient,
	TOKEN_EXPIRY,
	expiryDate,
	expiryFromValue,
	expiryValue,
	tokenLabel,
	tokenSteps,
} from "../lib/session";
import type { AgentActions } from "./AgentsPage";
import { Steps } from "./AgentsConnect";
import { CopyBlock } from "./CopyBlock";
import { Icon } from "./Icon";

type Token = MyAgent["tokens"][number];

/** Runs one action, keyed so its button shows it's busy; resolves to whether it worked. */
export type RunAction = (
	key: string,
	work: () => Promise<unknown>,
	onError: (text: string) => void,
) => Promise<boolean>;

/** What every row on the Agents page shares: the actions, which is busy, and which "Revoke" is asking. */
export interface RowShared {
	actions: AgentActions;
	run: RunAction;
	busy: string | null;
	confirming: string | null;
	setConfirming: (id: string | null) => void;
	now: number;
}

/** A "Revoke" that asks once more, in the page. */
export function ConfirmButton({
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

interface AgentRowProps extends RowShared {
	agent: MyAgent;
	/** The agent's full name, under its owner. */
	fullName: string;
	/** How long a new token lasts, in days; null for never. */
	days: number | null;
	chooseDays: (days: number | null) => void;
	/** A token just made for this agent, shown once. */
	issued: string | null;
	setIssued: (token: string | null) => void;
	error: string | null;
	setError: (text: string) => void;
	/** The apps this agent signs in from over OAuth. */
	signsInFrom: string[];
	client: McpClient;
	origin: string;
}

/** One of your agents: its tokens, making a new one, and revoking it. */
export function AgentRow(props: AgentRowProps) {
	const { agent, fullName, error, issued, setIssued, client, origin, now } = props;
	const active = !agent.revokedAt;
	return (
		<li className={`agents__agent${active ? "" : " agents__agent--revoked"}`}>
			<div className="agents__agent-head">
				<div className="agents__agent-name">
					<Icon name="bot" size={16} />
					<code>{fullName}</code>
					{active ? (
						<span className="pill pill--good">Active</span>
					) : (
						<span className="pill pill--neutral">Revoked</span>
					)}
					<span className="muted agents__meta">made {timeAgo(agent.createdAt, now)}</span>
				</div>
				{active ? <AgentControls {...props} /> : null}
			</div>
			{error !== null ? (
				<p className="error agents__row-error" role="alert">
					{error}
				</p>
			) : null}
			{issued ? (
				<div className="callout callout--good agents__issued" role="status">
					<div className="agents__issued-body">
						<p>
							<strong>New token for {fullName}.</strong> Copy it now: you won't see it again.
						</p>
						<CopyBlock text={issued} label="Copy token" />
						<Steps steps={tokenSteps(client, origin, issued)} />
						<button type="button" className="agents__small" onClick={() => setIssued(null)}>
							Done
						</button>
					</div>
				</div>
			) : null}
			<AgentTokens {...props} active={active} />
		</li>
	);
}

/** How long a new token lasts, making one, and revoking the agent. */
function AgentControls({
	agent,
	fullName,
	days,
	chooseDays,
	setIssued,
	setError,
	actions,
	run,
	busy,
	confirming,
	setConfirming,
}: AgentRowProps) {
	const tokenKey = `token:${agent.id}`;
	const agentKey = `agent:${agent.id}`;
	const makeToken = () =>
		run(
			tokenKey,
			async () => {
				const made = await actions.createToken(agent.id, days);
				setIssued(made.token);
			},
			setError,
		);
	return (
		<div className="agents__agent-actions">
			<label className="agents__expiry">
				<span className="sr-only">New token for {fullName} lasts</span>
				<select
					id={`expiry-${agent.id}`}
					value={expiryValue(days)}
					onChange={(event) => chooseDays(expiryFromValue(event.target.value))}
				>
					{TOKEN_EXPIRY.map((choice) => (
						<option key={expiryValue(choice.days)} value={expiryValue(choice.days)}>
							{choice.days === null ? "Never expires" : `Expires in ${choice.label}`}
						</option>
					))}
				</select>
			</label>
			<button type="button" className="accent agents__small" disabled={busy !== null} onClick={makeToken}>
				{busy === tokenKey ? "Making…" : "New token"}
			</button>
			<ConfirmButton
				id={agentKey}
				confirming={confirming}
				setConfirming={setConfirming}
				label="Revoke"
				question={`Revoke ${fullName}, its tokens and connected apps?`}
				busy={busy === agentKey}
				onConfirm={() => run(agentKey, () => actions.revokeAgent(agent.id), setError)}
			/>
		</div>
	);
}

/** The agent's tokens; or, for an active agent with none, how it signs in instead. */
function AgentTokens(props: AgentRowProps & { active: boolean }) {
	const { agent, active, signsInFrom } = props;
	if (agent.tokens.length > 0)
		return (
			<ul className="agents__tokens">
				{agent.tokens.map((token) => (
					<TokenRow key={token.id} {...props} token={token} />
				))}
			</ul>
		);
	if (!active) return null;
	return (
		<p className="muted agents__none">
			{signsInFrom.length ? `Signs in from ${signsInFrom.join(" and ")}, so it needs no token.` : "No tokens yet."}
		</p>
	);
}

function TokenRow(props: AgentRowProps & { active: boolean; token: Token }) {
	const { token, now } = props;
	return (
		<li className={`agents__token${token.revokedAt ? " agents__token--revoked" : ""}`}>
			<code>{tokenLabel(token.prefix)}</code>
			<span className="muted agents__meta">
				made {timeAgo(token.createdAt, now)} ·{" "}
				{token.expiresAt ? `expires ${expiryDate(token.expiresAt)}` : "never expires"} ·{" "}
				{token.lastUsedAt ? `used ${timeAgo(token.lastUsedAt, now)}` : "never used"}
			</span>
			<TokenStatus {...props} />
		</li>
	);
}

/** Revoked, expired, or a "Revoke" while the agent is active. */
function TokenStatus({
	token,
	active,
	now,
	actions,
	run,
	busy,
	confirming,
	setConfirming,
	setError,
}: AgentRowProps & { active: boolean; token: Token }) {
	if (token.revokedAt) return <span className="pill pill--neutral">Revoked</span>;
	if (token.expiresAt && Date.parse(token.expiresAt) <= now) return <span className="pill pill--neutral">Expired</span>;
	if (!active) return null;
	const key = `token:${token.id}`;
	return (
		<ConfirmButton
			id={key}
			confirming={confirming}
			setConfirming={setConfirming}
			label="Revoke"
			question="Revoke this token?"
			busy={busy === key}
			onConfirm={() => run(key, () => actions.revokeToken(token.id), setError)}
		/>
	);
}
