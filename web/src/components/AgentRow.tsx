import { type FormEvent, useRef, useState } from "react";
import type { Connection, IssuedToken, MyAgent } from "../api";
import type { RunAction } from "../hooks/useRowActions";
import { messageOf } from "../lib/errors";
import { agentState, expiryWords, whenWords } from "../lib/myAgents";
import {
	DEFAULT_TOKEN_DAYS,
	type McpClient,
	TOKEN_EXPIRY,
	expiryFromValue,
	expiryValue,
	tokenLabel,
	tokenSteps,
} from "../lib/session";
import { cn } from "../lib/utils";
import { AgentLimitsPanel } from "./AgentLimitsPanel";
import type { AgentActions } from "./AgentsPage";
import { Steps } from "./AgentsConnect";
import { ConfirmButton } from "./Confirm";
import { CopyBlock } from "./CopyBlock";
import { Icon } from "./Icon";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "./ui/alert-dialog";
import { Badge } from "./ui/badge";
import { Callout } from "./ui/box";
import { Button } from "./ui/button";
import {
	Dialog,
	DialogClose,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "./ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "./ui/dropdown-menu";
import { Field, Label, NativeSelect } from "./ui/field";

type Token = MyAgent["tokens"][number];

/** What every card on Your agents shares: the actions, which is busy, and which inline question is asking. */
export interface RowShared {
	actions: AgentActions;
	run: RunAction;
	busy: string | null;
	confirming: string | null;
	setConfirming: (id: string | null) => void;
	now: number;
}

interface AgentCardProps extends RowShared {
	agent: MyAgent;
	/** The agent's full name, under its owner. */
	fullName: string;
	/** The apps that sign in as it, over OAuth. */
	apps: Connection[];
	error: string | null;
	setError: (text: string) => void;
	client: McpClient;
	origin: string;
	/** Made since the list was first read: it fades in. */
	arrived?: boolean;
}

// A line about when something was made, used or connected.
const META = "text-meta text-muted-foreground";

/** "Claude Code and Codex": the apps an agent signs in from, each named once. */
const clientNames = (apps: Connection[]) => [...new Set(apps.map((app) => app.client))].join(" and ");

/** What revoking an agent does at once, and what it leaves. */
export function revokeWords(apps: Connection[]): string {
	const names = clientNames(apps);
	const plural = new Set(apps.map((app) => app.client)).size > 1;
	const disconnected = names ? `, and ${names} ${plural ? "are" : "is"} disconnected` : "";
	return `Its tokens stop working at once${disconnected}; its open claims stay until freed.`;
}

/**
 * One of your agents, in a card of its own: its state, the apps it signs in from (each to disconnect), its limits on
 * work for other people, and its tokens, folded away. Revoking it is in its ⋯ menu.
 */
export function AgentCard(props: AgentCardProps) {
	const { agent, fullName, apps, error, now, arrived, actions, run, busy, setError } = props;
	const agentKey = `agent:${agent.id}`;
	return (
		<li className={cn("grid gap-3 border-t border-border px-0.5 py-4 first:border-t-0", arrived && "animate-appear")}>
			<div className="flex items-start justify-between gap-3">
				<div className="grid min-w-0 gap-1">
					<h3 className="flex min-w-0 items-center gap-2 text-body">
						<Icon name="bot" className="flex-none text-muted-foreground" />
						<code className="bg-link-soft font-semibold wrap-anywhere text-link">{fullName}</code>
					</h3>
					<p className="m-0 text-ui text-muted-foreground">
						{agentState(agent, apps, now)}
						<span className="text-meta"> · made {whenWords(agent.createdAt, now)}</span>
					</p>
				</div>
				<AgentMenu
					fullName={fullName}
					apps={apps}
					busy={busy === agentKey}
					onRevoke={() => void run(agentKey, () => actions.revokeAgent(agent.id), setError)}
				/>
			</div>
			{error !== null ? (
				<p className="m-0 animate-appear text-bad" role="alert">
					{error}
				</p>
			) : null}
			<SignsInFrom {...props} />
			<AgentLimitsPanel {...props} />
			<AgentTokens {...props} />
		</li>
	);
}

/** The ⋯ menu: revoking the agent, asked first in a dialog that says what it does. */
function AgentMenu(props: { fullName: string; apps: Connection[]; busy: boolean; onRevoke: () => void }) {
	const { fullName, apps, busy, onRevoke } = props;
	const [asking, setAsking] = useState(false);
	const trigger = useRef<HTMLButtonElement>(null);
	return (
		<>
			<DropdownMenu>
				<DropdownMenuTrigger asChild>
					<Button ref={trigger} variant="ghost" size="icon" aria-label={`More for ${fullName}`} disabled={busy}>
						<Icon name="more" />
					</Button>
				</DropdownMenuTrigger>
				<DropdownMenuContent align="end">
					<DropdownMenuItem className="text-bad" onSelect={() => setAsking(true)}>
						Revoke agent…
					</DropdownMenuItem>
				</DropdownMenuContent>
			</DropdownMenu>
			<AlertDialog open={asking} onOpenChange={setAsking}>
				<AlertDialogContent
					// The menu item that asked is gone: focus goes back to the ⋯ that opened the menu.
					onCloseAutoFocus={(event) => {
						event.preventDefault();
						trigger.current?.focus();
					}}
				>
					<AlertDialogHeader>
						<AlertDialogTitle>Revoke {fullName}?</AlertDialogTitle>
						<AlertDialogDescription>{revokeWords(apps)}</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>Keep agent</AlertDialogCancel>
						<AlertDialogAction onClick={onRevoke}>Revoke agent</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</>
	);
}

/** The apps that sign in as the agent, each with when it connected and a way to disconnect it. */
function SignsInFrom({ apps, fullName, now, actions, run, busy, confirming, setConfirming, setError }: AgentCardProps) {
	if (!apps.length) return null;
	return (
		<ul className="m-0 grid list-none gap-1.5 p-0">
			{apps.map((app) => {
				const key = `conn:${app.id}`;
				return (
					<li key={app.id} className="flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
						<span className="min-w-0 text-ui wrap-anywhere">
							Signs in from <strong>{app.client}</strong>
							<span className={META}> · connected {whenWords(app.createdAt, now)}</span>
						</span>
						<ConfirmButton
							id={key}
							confirming={confirming}
							setConfirming={setConfirming}
							label="Disconnect"
							question={`Disconnect ${app.client}? It can't act as ${fullName} until it signs in again.`}
							keep="Keep it connected"
							busy={busy === key}
							onConfirm={() => run(key, () => actions.disconnect(app.id), setError)}
						/>
					</li>
				);
			})}
		</ul>
	);
}

// The tokens' disclosure: its summary a quiet line with the browser's triangle, written out.
const SUMMARY = cn(
	"list-item w-fit cursor-pointer list-inside list-[disclosure-closed] text-ui font-medium text-muted-foreground",
	"[[open]>&]:list-[disclosure-open]",
);

/** The agent's tokens, folded away under how many there are, with a way to make a new one. */
function AgentTokens(props: AgentCardProps) {
	const { agent, fullName, apps, client, origin, actions } = props;
	const usable = agent.tokens.filter((token) => !token.revokedAt).length;
	const all = agent.tokens.length;
	return (
		<details className="disclosure">
			<summary className={SUMMARY}>Tokens ({usable === all ? all : `${usable} of ${all} not revoked`})</summary>
			<div className="grid justify-items-start gap-2 pt-2 pl-4">
				{all ? (
					<ul className="m-0 grid list-none gap-0.5 self-stretch p-0">
						{agent.tokens.map((token) => (
							<TokenRow key={token.id} {...props} token={token} />
						))}
					</ul>
				) : (
					<p className="m-0 text-ui text-muted-foreground">
						{apps.length ? `It signs in from ${clientNames(apps)}, so it needs no token.` : "No tokens yet."}
					</p>
				)}
				<NewTokenDialog
					fullName={fullName}
					client={client}
					origin={origin}
					create={(days) => actions.createToken(agent.id, days)}
				/>
			</div>
		</details>
	);
}

function TokenRow(props: AgentCardProps & { token: Token }) {
	const { token, now } = props;
	return (
		<li className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5 py-1">
			<code className={cn(token.revokedAt && "text-muted-foreground line-through")}>{tokenLabel(token.prefix)}</code>
			<span className={META}>
				made {whenWords(token.createdAt, now)} · {expiryWords(token.expiresAt, now)} ·{" "}
				{token.lastUsedAt ? `used ${whenWords(token.lastUsedAt, now)}` : "never used"}
			</span>
			<TokenStatus {...props} />
		</li>
	);
}

/** Revoked, expired, or a "Revoke" while it works. */
function TokenStatus({
	token,
	now,
	actions,
	run,
	busy,
	confirming,
	setConfirming,
	setError,
}: AgentCardProps & { token: Token }) {
	if (token.revokedAt) return <Badge tone="neutral">Revoked</Badge>;
	if (token.expiresAt && Date.parse(token.expiresAt) <= now) return <Badge tone="neutral">Expired</Badge>;
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

/**
 * New token…: a dialog that asks how long it lasts, makes it, and shows it once, with the setup for the chosen client.
 * Closing it before anything is copied asks first: the token can't be shown again.
 */
export function NewTokenDialog(props: {
	fullName: string;
	client: McpClient;
	origin: string;
	create: (days: number | null) => Promise<IssuedToken>;
}) {
	const { fullName, client, origin, create } = props;
	const [open, setOpen] = useState(false);
	const [days, setDays] = useState<number | null>(DEFAULT_TOKEN_DAYS);
	const [token, setToken] = useState<string | null>(null);
	const [copied, setCopied] = useState(false);
	const [warned, setWarned] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const begin = () => {
		setDays(DEFAULT_TOKEN_DAYS);
		setToken(null);
		setCopied(false);
		setWarned(false);
		setError(null);
		setOpen(true);
	};
	const close = () => {
		if (token && !copied && !warned) setWarned(true);
		else setOpen(false);
	};
	const make = async (event: FormEvent) => {
		event.preventDefault();
		setBusy(true);
		setError(null);
		try {
			setToken((await create(days)).token);
		} catch (err) {
			setError(messageOf(err));
		} finally {
			setBusy(false);
		}
	};
	return (
		<Dialog open={open} onOpenChange={(next) => (next ? begin() : close())}>
			<DialogTrigger asChild>
				<Button size="sm">New token…</Button>
			</DialogTrigger>
			<DialogContent>
				{token ? (
					<TokenMade
						fullName={fullName}
						token={token}
						client={client}
						origin={origin}
						warned={warned && !copied}
						onCopy={() => setCopied(true)}
						onDone={close}
					/>
				) : (
					<form className="grid gap-4" onSubmit={make}>
						<DialogHeader>
							<DialogTitle>New token for {fullName}</DialogTitle>
							<DialogDescription>
								For a client that can't sign in through your browser. GitHive shows it once, as it's made.
							</DialogDescription>
						</DialogHeader>
						<Field>
							<Label htmlFor="new-token-expiry" className="text-body-sm">
								It stops working
							</Label>
							<NativeSelect
								id="new-token-expiry"
								className="w-full max-w-60"
								value={expiryValue(days)}
								onChange={(event) => setDays(expiryFromValue(event.target.value))}
							>
								{TOKEN_EXPIRY.map((choice) => (
									<option key={expiryValue(choice.days)} value={expiryValue(choice.days)}>
										{choice.days === null ? "Never" : `In ${choice.label}`}
									</option>
								))}
							</NativeSelect>
						</Field>
						{error ? (
							<p className="m-0 animate-appear text-bad" role="alert">
								{error}
							</p>
						) : null}
						<DialogFooter>
							<DialogClose asChild>
								<Button>Cancel</Button>
							</DialogClose>
							<Button type="submit" variant="primary" disabled={busy}>
								{busy ? "Making…" : "Make token"}
							</Button>
						</DialogFooter>
					</form>
				)}
			</DialogContent>
		</Dialog>
	);
}

/** A token just made, shown this once: to copy, with the setup that uses it; and a warning if it's closed uncopied. */
export function TokenMade(props: {
	fullName: string;
	token: string;
	client: McpClient;
	origin: string;
	/** It was asked to close before anything was copied. */
	warned: boolean;
	onCopy: () => void;
	onDone: () => void;
}) {
	const { fullName, token, client, origin, warned, onCopy, onDone } = props;
	return (
		<div className="grid min-w-0 gap-4">
			<DialogHeader>
				<DialogTitle>New token for {fullName}</DialogTitle>
				<DialogDescription>Copy it now: GitHive shows it this once.</DialogDescription>
			</DialogHeader>
			<CopyBlock text={token} label="Copy token" onCopy={onCopy} />
			<Steps steps={tokenSteps(client, origin, token)} onCopy={onCopy} />
			{warned ? (
				<Callout tone="warn" className="animate-appear" role="alert">
					<p>
						<strong>You haven't copied it.</strong> Once this closes, the token can't be shown again, and you'd make
						another.
					</p>
				</Callout>
			) : null}
			<DialogFooter>
				<Button variant={warned ? "danger" : "primary"} onClick={onDone}>
					{warned ? "Close without copying" : "Done"}
				</Button>
			</DialogFooter>
		</div>
	);
}

/** A revoked agent: its name, that it's revoked, and when. */
export function RevokedAgent({ agent, fullName, now }: { agent: MyAgent; fullName: string; now: number }) {
	return (
		<li className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1 border-t border-border px-0.5 py-2.5 first:border-t-0">
			<Icon name="bot" size={14} className="text-muted-foreground" />
			<code className="wrap-anywhere">{fullName}</code>
			<Badge tone="neutral">Revoked</Badge>
			<span className={META}>
				made {whenWords(agent.createdAt, now)}
				{agent.revokedAt ? ` · revoked ${whenWords(agent.revokedAt, now)}` : ""}
			</span>
		</li>
	);
}
