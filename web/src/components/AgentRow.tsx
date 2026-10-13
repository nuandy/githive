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
import type { RunAction } from "../hooks/useRowActions";
import type { AgentActions } from "./AgentsPage";
import { Steps } from "./AgentsConnect";
import { ConfirmButton } from "./Confirm";
import { cn } from "../lib/utils";
import { CopyBlock } from "./CopyBlock";
import { AgentLimitsPanel } from "./AgentLimitsPanel";
import { Icon } from "./Icon";
import { Badge } from "./ui/badge";
import { Callout } from "./ui/box";
import { Button } from "./ui/button";
import { Label, NativeSelect } from "./ui/field";

type Token = MyAgent["tokens"][number];

/** What every row on the Agents page shares: the actions, which is busy, and which "Revoke" is asking. */
export interface RowShared {
	actions: AgentActions;
	run: RunAction;
	busy: string | null;
	confirming: string | null;
	setConfirming: (id: string | null) => void;
	now: number;
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
	/** Made since the list was first read: it fades in. */
	arrived?: boolean;
}

// A token's or an agent's line about when it was made and used.
const META = "text-meta text-muted-foreground";

/** One of your agents: its tokens, making a new one, and revoking it. */
export function AgentRow(props: AgentRowProps) {
	const { agent, fullName, error, issued, setIssued, client, origin, now, arrived } = props;
	const active = !agent.revokedAt;
	return (
		<li className={cn("grid gap-2.5 border-t border-border px-4 py-3.5 first:border-t-0", arrived && "animate-appear")}>
			<div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
				<div className="flex min-w-0 flex-wrap items-center gap-2">
					<Icon name="bot" size={16} />
					<code className="bg-link-soft text-ui font-semibold text-link">{fullName}</code>
					{active ? <Badge tone="good">Active</Badge> : <Badge tone="neutral">Revoked</Badge>}
					<span className={META}>made {timeAgo(agent.createdAt, now)}</span>
				</div>
				{active ? <AgentControls {...props} /> : null}
			</div>
			{error !== null ? (
				<p className="m-0 animate-appear text-bad" role="alert">
					{error}
				</p>
			) : null}
			{issued ? (
				<Callout tone="good" className="animate-appear" role="status">
					<div className="grid w-full min-w-0 gap-2">
						<p>
							<strong>New token for {fullName}.</strong> Copy it now: you won't see it again.
						</p>
						<CopyBlock text={issued} label="Copy token" />
						<Steps steps={tokenSteps(client, origin, issued)} />
						<Button size="sm" className="justify-self-start" onClick={() => setIssued(null)}>
							Done
						</Button>
					</div>
				</Callout>
			) : null}
			{active ? <AgentLimitsPanel {...props} /> : null}
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
		<div className="flex flex-wrap items-center gap-2">
			<Label>
				<span className="sr-only">New token for {fullName} lasts</span>
				<NativeSelect
					id={`expiry-${agent.id}`}
					className="px-1.5 py-0.75 text-ui"
					value={expiryValue(days)}
					onChange={(event) => chooseDays(expiryFromValue(event.target.value))}
				>
					{TOKEN_EXPIRY.map((choice) => (
						<option key={expiryValue(choice.days)} value={expiryValue(choice.days)}>
							{choice.days === null ? "Never expires" : `Expires in ${choice.label}`}
						</option>
					))}
				</NativeSelect>
			</Label>
			<Button variant="primary" size="sm" disabled={busy !== null} onClick={makeToken}>
				{busy === tokenKey ? "Making…" : "New token"}
			</Button>
			<ConfirmButton
				id={agentKey}
				confirming={confirming}
				setConfirming={setConfirming}
				label="Revoke"
				question={`Revoke ${fullName}? Its tokens and connected apps stop working, for good.`}
				keep="Keep agent"
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
			<ul className="m-0 grid list-none gap-0.5 p-0 pl-6">
				{agent.tokens.map((token) => (
					<TokenRow key={token.id} {...props} token={token} />
				))}
			</ul>
		);
	if (!active) return null;
	return (
		<p className="m-0 pl-6 text-ui text-muted-foreground">
			{signsInFrom.length ? `Signs in from ${signsInFrom.join(" and ")}, so it needs no token.` : "No tokens yet."}
		</p>
	);
}

function TokenRow(props: AgentRowProps & { active: boolean; token: Token }) {
	const { token, now } = props;
	return (
		<li className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5 py-1">
			<code className={cn(token.revokedAt && "text-muted-foreground line-through")}>{tokenLabel(token.prefix)}</code>
			<span className={META}>
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
	if (token.revokedAt) return <Badge tone="neutral">Revoked</Badge>;
	if (token.expiresAt && Date.parse(token.expiresAt) <= now) return <Badge tone="neutral">Expired</Badge>;
	if (!active) return null;
	const key = `token:${token.id}`;
	return (
		<ConfirmButton
			id={key}
			confirming={confirming}
			setConfirming={setConfirming}
			label="Revoke"
			question={`Revoke ${tokenLabel(token.prefix)}? Whatever signs in with it stops working.`}
			keep="Keep token"
			busy={busy === key}
			onConfirm={() => run(key, () => actions.revokeToken(token.id), setError)}
		/>
	);
}
