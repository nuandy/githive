import { type ConnectStep, MCP_CLIENTS, type McpClient, connectSteps, isMcpClient } from "../lib/session";
import { CopyBlock } from "./CopyBlock";

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
		<ol className="agents__steps">
			{steps.map((step, index) => (
				<li key={index}>
					<WithCode text={step.text} />
					{step.copy ? <CopyBlock text={step.copy} /> : null}
				</li>
			))}
		</ol>
	);
}

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
		<section className="agents__connect" aria-labelledby="connect-title">
			<h2 id="connect-title">Connect an agent</h2>
			<div className="agents__clients" role="radiogroup" aria-label="Your agent's app">
				{MCP_CLIENTS.map((option) => (
					<label key={option.id} className={`agents__client${client === option.id ? " is-selected" : ""}`}>
						<input
							type="radio"
							name="mcp-client"
							value={option.id}
							checked={client === option.id}
							onChange={() => chooseClient(option.id)}
						/>
						{option.label}
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
							shows the token once, with the setup for {yourClient} filled in, ready to copy.
						</p>
					</div>
				</div>
			</div>
		</section>
	);
}
