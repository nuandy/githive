import { type ReactNode, useState } from "react";
import type { WatchState } from "../hooks/useConnectionWatch";
import { href } from "../lib/routes";
import { type ConnectStep, MCP_CLIENTS, type McpClient, connectSteps, isMcpClient, workPrompt } from "../lib/session";
import { cn } from "../lib/utils";
import { CopyBlock } from "./CopyBlock";
import { Icon } from "./Icon";
import { Badge } from "./ui/badge";
import { Box, BoxBody } from "./ui/box";
import { Label, NativeSelect } from "./ui/field";

const CLIENT_KEY = "githive:mcp-client";

/** The client chosen last time, in this browser; Claude Code at first. */
export function rememberedClient(): McpClient {
	try {
		const saved = localStorage.getItem(CLIENT_KEY);
		return isMcpClient(saved) ? saved : "claude-code";
	} catch {
		return "claude-code";
	}
}

export function rememberClient(client: McpClient) {
	try {
		localStorage.setItem(CLIENT_KEY, client);
	} catch {
		// Only a convenience. Without storage, the choice lasts as long as the page.
	}
}

/** Text with `code` in backticks. */
function WithCode({ text }: { text: string }) {
	const parts = text.split("`");
	return (
		<>{parts.map((part, index) => (index % 2 ? <code key={index}>{part}</code> : <span key={index}>{part}</span>))}</>
	);
}

/**
 * Numbered steps, each with what to copy; `note` under the last of them, and `children`, steps of their own, after
 * them.
 */
export function Steps({
	steps,
	onCopy,
	note,
	children,
}: {
	steps: ConnectStep[];
	/** Something was copied (a command that connects, say). */
	onCopy?: () => void;
	note?: ReactNode;
	children?: ReactNode;
}) {
	return (
		<ol className="m-0 grid list-decimal gap-2.5 pl-[1.3em]">
			{steps.map((step, index) => (
				<li key={index} className="min-w-0">
					<WithCode text={step.text} />
					{step.copy ? <CopyBlock text={step.copy} className="mt-1.5" {...(onCopy ? { onCopy } : {})} /> : null}
					{index === steps.length - 1 ? note : null}
				</li>
			))}
			{children}
		</ol>
	);
}

/** How the look for a new connection is going, once a command is copied: a status line, empty until then. */
function WatchNote({ state, yourClient }: { state: WatchState; yourClient: string }) {
	let said: ReactNode = null;
	if (state.kind === "waiting")
		said = (
			<span className="inline-flex items-center gap-1.5 text-muted-foreground">
				<Icon name="clock" size={14} /> Waiting for {yourClient} to connect…
			</span>
		);
	else if (state.kind === "found")
		said = (
			<strong className="text-good">
				{state.connection.client} connected as {state.connection.agent ?? "an agent"} ✓
			</strong>
		);
	else if (state.kind === "gave-up")
		said = (
			<span className="text-muted-foreground">
				No new connection yet. Once you've signed in from {yourClient}, it shows under Your agents.
			</span>
		);
	return (
		<p role="status" className="mt-1.5 mb-0 text-ui empty:mt-0">
			{said ? (
				<span key={state.kind} className="animate-appear">
					{said}
				</span>
			) : null}
		</p>
	);
}

/** The step after connecting: what to ask the agent first, naming one of your repos, which you may choose. */
function GiveWorkStep({ repos }: { repos: string[] | undefined }) {
	const [chosen, setChosen] = useState<string | null>(null);
	const repo = chosen !== null && repos?.includes(chosen) ? chosen : repos?.[0];
	if (repos === undefined)
		return <li className="min-w-0">Give it work: ask it to work in one of your repositories, through GitHive.</li>;
	if (!repo)
		return (
			<li className="min-w-0">
				Give it work: <a href={href.newRepo()}>make a repository</a> first, then ask it to work there, through GitHive.
			</li>
		);
	// The step's parts in a grid inside it: a grid list item loses its number.
	return (
		<li className="min-w-0">
			<div className="grid gap-1.5">
				<span>Give it work. Ask it, for example:</span>
				{repos.length > 1 ? (
					<Label className="flex flex-wrap items-center gap-2 text-ui font-normal">
						In
						<NativeSelect
							className="max-w-full px-1.5 py-0.75 font-mono text-meta"
							aria-label="The repository to name"
							value={repo}
							onChange={(event) => setChosen(event.target.value)}
						>
							{repos.map((name) => (
								<option key={name} value={name}>
									{name}
								</option>
							))}
						</NativeSelect>
					</Label>
				) : null}
				<CopyBlock text={workPrompt(repo)} />
			</div>
		</li>
	);
}

// A way to connect's title, with a pill beside it.
const WAY_TITLE = "mt-0 mb-2.5 flex flex-wrap items-center gap-2 text-body";

interface ConnectSectionProps {
	client: McpClient;
	chooseClient: (client: McpClient) => void;
	origin: string;
	/** The chosen client's name, or "your client". */
	yourClient: string;
	clientLabel: string;
	/** Your repositories, most recently active first, to name in what to ask an agent; undefined while loading. */
	repos?: string[] | undefined;
	/** How the look for a new connection is going. */
	watch?: WatchState;
	/** A command that connects was copied: look for the connection it makes. */
	onCopied?: () => void;
}

/** How to connect an agent from the chosen app: signing in, or a token; then what to ask it. */
export function ConnectSection(props: ConnectSectionProps) {
	const { client, chooseClient, origin, yourClient, clientLabel, repos, watch = { kind: "idle" }, onCopied } = props;
	return (
		<section className="grid gap-3" aria-labelledby="connect-title">
			<h2 id="connect-title" className="text-body-sm">
				Connect an agent
			</h2>
			<div
				className="inline-flex flex-wrap gap-1 justify-self-start rounded-md border border-input bg-surface-2 p-0.75"
				role="radiogroup"
				aria-label="Your agent's app"
			>
				{MCP_CLIENTS.map((option) => (
					<label
						key={option.id}
						className={cn(
							"inline-flex cursor-pointer items-center rounded-md px-3 py-1.25 text-ui-lg font-medium",
							"transition-[color,background-color] duration-fast ease-out",
							"has-[input:focus-visible]:outline-2 has-[input:focus-visible]:outline-offset-1 has-[input:focus-visible]:outline-ring",
							client === option.id ? "bg-card text-foreground" : "text-muted-foreground",
						)}
					>
						<input
							type="radio"
							className="pointer-events-none absolute opacity-0"
							name="mcp-client"
							value={option.id}
							checked={client === option.id}
							onChange={() => chooseClient(option.id)}
						/>
						{option.label}
					</label>
				))}
			</div>
			<div className="grid grid-cols-[repeat(auto-fit,minmax(280px,1fr))] gap-3">
				<Box asChild>
					<div>
						<BoxBody className="min-w-0">
							<h3 className={WAY_TITLE}>
								Sign in from {client === "other" ? "the client" : clientLabel} <Badge tone="accent">Recommended</Badge>
							</h3>
							<Steps
								steps={connectSteps(client, origin)}
								{...(onCopied ? { onCopy: onCopied } : {})}
								note={<WatchNote state={watch} yourClient={yourClient} />}
							>
								<GiveWorkStep repos={repos} />
							</Steps>
						</BoxBody>
					</div>
				</Box>
				<Box asChild>
					<div>
						<BoxBody className="min-w-0">
							<h3 className={WAY_TITLE}>Or use a token</h3>
							<p className="mt-2.5 mb-0 text-muted-foreground">
								For a client that can't sign in through your browser. Make an agent below and choose New token on it.
								GitHive shows the token once, with the setup for {yourClient} filled in, ready to copy.
							</p>
						</BoxBody>
					</div>
				</Box>
			</div>
		</section>
	);
}
