import type { Connection, MyAgent } from "../api";
import type { RepoRow } from "./repos";
import { href } from "./routes";

// The Repositories page's "Get started": make a repository, connect an agent, give it a task, see it land. Each step
// ticks itself from what the page reads: your repos and their counts, your agents and the apps signed in as them.

export type StartStepId = "repo" | "agent" | "task" | "land";

export interface StartStep {
	id: StartStepId;
	title: string;
	/** What to do, in a line. */
	hint: string;
	done: boolean;
	/** Where it's done, and the link's words; null when there's nowhere yet (no repo to watch). */
	href: string | null;
	action: string;
}

export interface GettingStarted {
	steps: StartStep[];
	/** The first step not done, or null once all are. */
	next: StartStepId | null;
	done: number;
	/** Something has landed: it may be put away. */
	dismissable: boolean;
}

/** An agent is connected once an app signs in as it, or one of its tokens has been used: not just for being made. */
function connected(agents: MyAgent[], connections: Connection[]): boolean {
	if (connections.some((connection) => connection.agentId)) return true;
	return agents.some((agent) => agent.tokens.some((token) => !!token.lastUsedAt));
}

/** The steps as they stand, from the reader's repos (other people's public ones don't count), agents and apps. */
export function gettingStarted(rows: RepoRow[], agents: MyAgent[], connections: Connection[]): GettingStarted {
	const yours = rows.filter((row) => !row.public);
	const landed = yours.some((row) => row.merged > 0 || !!row.stretch);
	// Something landing means a task came first.
	const claimed = landed || yours.some((row) => row.open > 0);
	const atWork = yours.find((row) => row.open > 0) ?? yours.find((row) => row.merged > 0) ?? yours[0];
	const steps: StartStep[] = [
		{
			id: "repo",
			title: "Make a repository",
			hint: "Start one fresh, import one from Git, or copy one here.",
			done: yours.length > 0,
			href: href.newRepo(),
			action: "New repository",
		},
		{
			id: "agent",
			title: "Connect an agent",
			hint: "Add GitHive to Claude Code, Codex or another MCP client, and sign in.",
			done: connected(agents, connections),
			href: href.agents(),
			action: "Connect one",
		},
		{
			id: "task",
			title: "Give it a task",
			hint: "Ask your agent to do something in your repository, through GitHive. It claims its files first.",
			done: claimed,
			href: href.agents(),
			action: "Copy a prompt for it",
		},
		{
			id: "land",
			title: "See it land",
			hint: "Its change is reviewed, checked and merged. The repository's Hive tab shows it happen.",
			done: landed,
			href: atWork ? href.repo(atWork.name) : null,
			action: "Watch the Hive",
		},
	];
	return {
		steps,
		next: steps.find((step) => !step.done)?.id ?? null,
		done: steps.filter((step) => step.done).length,
		dismissable: landed,
	};
}
