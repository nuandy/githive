import { type ConnectStep, MCP_CLIENTS, type McpClient, connectSteps, isMcpClient } from "../lib/session";
import { cn } from "../lib/utils";
import { CopyBlock } from "./CopyBlock";
import { Badge } from "./ui/badge";
import { Box, BoxBody } from "./ui/box";

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

/** Numbered steps, each with what to copy. */
export function Steps({ steps }: { steps: ConnectStep[] }) {
	return (
		<ol className="m-0 grid list-decimal gap-2.5 pl-[1.3em]">
			{steps.map((step, index) => (
				<li key={index} className="min-w-0">
					<WithCode text={step.text} />
					{step.copy ? <CopyBlock text={step.copy} className="mt-1.5" /> : null}
				</li>
			))}
		</ol>
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
}

/** How to connect an agent from the chosen app: signing in, or a token. */
export function ConnectSection({ client, chooseClient, origin, yourClient, clientLabel }: ConnectSectionProps) {
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
							<Steps steps={connectSteps(client, origin)} />
						</BoxBody>
					</div>
				</Box>
				<Box asChild>
					<div>
						<BoxBody className="min-w-0">
							<h3 className={WAY_TITLE}>Or use a token</h3>
							<p className="mt-2.5 mb-0 text-muted-foreground">
								For a client that can't sign in through your browser. Make an agent below and choose New token. GitHive
								shows the token once, with the setup for {yourClient} filled in, ready to copy.
							</p>
						</BoxBody>
					</div>
				</Box>
			</div>
		</section>
	);
}
