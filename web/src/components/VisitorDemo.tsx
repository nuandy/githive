import { useState } from "react";
import { messageOf } from "../lib/errors";
import { cn } from "../lib/utils";
import { usePoll } from "../hooks/usePoll";
import { agentsOf } from "./DemoRun";
import { Button } from "./ui/button";

// The demo repo's Hive tab, read by someone who isn't signed in: a way to start a demo run anyway, under the same
// limits as anyone (one at a time, up to 100 a day). While a run is going it shows nothing: the banner below says how
// the run is doing.

export interface VisitorDemoApi {
	providers(): Promise<{ demoRepo?: string }>;
	runs(): Promise<{ running: { fullName: string } | null; agentsPerRun?: number }>;
	start(): Promise<{ id: string; repo: string }>;
}

/** Whether to offer a run on `repo`: only the demo repo, and only once the runs are read and none is going. */
export function visitorMayStart(
	repo: string,
	setup: { demoRepo?: string } | undefined,
	runs: { running: unknown } | undefined,
): boolean {
	return !!setup?.demoRepo && setup.demoRepo === repo && !!runs && !runs.running;
}

/** Starts a demo run for a visitor on the demo repo's Hive tab; nothing on any other repo. */
export function VisitorDemo({ repo, api }: { repo: string; api: VisitorDemoApi }) {
	const setup = usePoll("visitor-demo:providers", () => api.providers(), 10 * 60_000);
	const runs = usePoll("visitor-demo:runs", () => api.runs(), 30_000);
	const [starting, setStarting] = useState(false);
	const [problem, setProblem] = useState<string | null>(null);
	if (!visitorMayStart(repo, setup.data, runs.data)) return null;

	const start = async () => {
		setStarting(true);
		setProblem(null);
		try {
			await api.start();
			runs.refresh();
		} catch (err) {
			setProblem(messageOf(err));
			runs.refresh();
		} finally {
			setStarting(false);
		}
	};
	return (
		<section
			aria-labelledby="visitor-demo-title"
			className={cn(
				"mx-auto mt-4 flex w-full max-w-(--page-width) animate-fade px-6 to-560:px-4",
				"flex-wrap items-center gap-x-4 gap-y-2",
			)}
		>
			<p className="m-0 min-w-0 flex-[1_1_320px] text-ui">
				<strong id="visitor-demo-title">Watch this hive build a game, no account needed.</strong>{" "}
				<span className="text-muted-foreground">
					{agentsOf(runs.data?.agentsPerRun, "own")} build Honeycomb, a word game, in about 10 minutes.
				</span>
			</p>
			<Button variant="primary" size="sm" onClick={start} disabled={starting}>
				{starting ? "Starting…" : "Start a demo run"}
			</Button>
			{problem ? (
				<p className="m-0 basis-full text-bad" role="alert">
					{problem}
				</p>
			) : null}
		</section>
	);
}
