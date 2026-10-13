import { useState } from "react";
import type { Connection, MyAgent } from "../api";
import { useChanged } from "../hooks/useChanged";
import { usePoll } from "../hooks/usePoll";
import { type GettingStarted, type StartStep, gettingStarted } from "../lib/gettingStarted";
import type { RepoRow } from "../lib/repos";
import { cn } from "../lib/utils";
import { Icon } from "./Icon";
import { Box, BoxHeader, BoxTitle } from "./ui/box";
import { Button } from "./ui/button";

// "Get started" on the Repositories page: make a repository, connect an agent, give it a task, see it land. It ticks
// itself as the page reads what's happened, leads to where each step is done, and, once something has landed, can be
// put away for good (in this browser).

/** What the checklist reads besides the repos: your agents, and the apps signed in as them. */
export interface StartApi {
	agents(): Promise<MyAgent[]>;
	connections(): Promise<Connection[]>;
}

const DISMISSED = "githive:get-started-dismissed";

function readDismissed(): boolean {
	try {
		return localStorage.getItem(DISMISSED) === "1";
	} catch {
		return false;
	}
}

function rememberDismissed() {
	try {
		localStorage.setItem(DISMISSED, "1");
	} catch {
		// Only a convenience: without storage, it's put away until the page reloads.
	}
}

/** The checklist with its data: shown once the repos, agents and apps are read, unless it was put away. */
export function GetStarted({ rows, loaded, api }: { rows: RepoRow[]; loaded: boolean; api: StartApi }) {
	const [dismissed, setDismissed] = useState(readDismissed);
	// Read often while it's shown, so a step ticks soon after it's done.
	const agents = usePoll(dismissed ? null : "start:agents", api.agents, 15_000);
	const connections = usePoll(dismissed ? null : "start:connections", api.connections, 15_000);
	if (dismissed || !loaded || !agents.loaded || !connections.loaded) return null;
	const start = gettingStarted(rows, agents.data ?? [], connections.data ?? []);
	return (
		<GetStartedView
			start={start}
			onDismiss={() => {
				rememberDismissed();
				setDismissed(true);
			}}
		/>
	);
}

/** The checklist as it stands: four steps in a box; or, with all four done, a line saying so. */
export function GetStartedView({ start, onDismiss }: { start: GettingStarted; onDismiss: () => void }) {
	if (start.next === null)
		return (
			<p className="mb-5 flex animate-fade flex-wrap items-center gap-x-3 gap-y-1.5 border-l-3 border-l-good bg-good-soft px-3.5 py-2">
				<Icon name="check" className="flex-none text-good" />
				<span className="min-w-0 flex-1">
					<strong>You're set up.</strong> An agent's change has landed in your repository.
				</span>
				<Button size="sm" variant="ghost" onClick={onDismiss}>
					Dismiss
				</Button>
			</p>
		);
	return (
		<Box aria-labelledby="get-started-title" className="mb-5 animate-fade">
			<BoxHeader>
				<BoxTitle id="get-started-title">Get started</BoxTitle>
				<span className="text-meta font-normal text-muted-foreground">{start.done} of 4 done</span>
				{start.dismissable ? (
					<Button size="sm" variant="ghost" className="ml-auto" onClick={onDismiss}>
						Dismiss
					</Button>
				) : null}
			</BoxHeader>
			<ol className="m-0 grid list-none grid-cols-1 gap-x-6 gap-y-5 px-0.5 py-4 min-[361px]:grid-cols-2 min-[901px]:grid-cols-4">
				{start.steps.map((step, index) => (
					<Step key={step.id} step={step} number={index + 1} next={start.next === step.id} />
				))}
			</ol>
		</Box>
	);
}

/** One step: its mark (a tick once done, else its number), what it is, and the way to do it. */
function Step({ step, number, next }: { step: StartStep; number: number; next: boolean }) {
	// A tick that comes while the page is open comes in rising.
	const ticked = useChanged(step.done) && step.done;
	return (
		<li className="grid content-start gap-1.5" {...(next ? { "aria-current": "step" as const } : {})}>
			<div className="flex items-center gap-2">
				<span
					key={String(step.done)}
					aria-hidden="true"
					className={cn(
						"inline-flex size-5.5 flex-none items-center justify-center rounded-full text-caption font-bold",
						step.done && "bg-good text-good-foreground",
						!step.done && next && "border-2 border-foreground text-foreground",
						!step.done && !next && "border border-border-strong text-muted-foreground",
						ticked && "animate-appear",
					)}
				>
					{step.done ? <Icon name="check" size={14} /> : number}
				</span>
				<strong className={cn("text-body-sm", step.done && "text-muted-foreground")}>
					{step.title}
					{step.done ? <span className="sr-only"> (done)</span> : null}
				</strong>
			</div>
			<p className="m-0 text-ui text-muted-foreground">{step.hint}</p>
			{step.href && !step.done ? (
				next ? (
					<Button asChild size="sm" variant="primary" className="justify-self-start">
						<a href={step.href}>{step.action}</a>
					</Button>
				) : (
					<a className="justify-self-start text-ui" href={step.href}>
						{step.action}
					</a>
				)
			) : null}
		</li>
	);
}
