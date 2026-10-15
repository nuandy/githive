import { useState } from "react";
import { messageOf } from "../lib/errors";
import { cn } from "../lib/utils";
import { usePoll } from "../hooks/usePoll";
import { agentsOf } from "./DemoRun";
import { Button } from "./ui/button";

// The demo repo's Hive tab: a way to start a demo run from the hive itself, for anyone, signed in or not, under the
// limits every run has (one at a time, up to 100 a day). While a run is going it shows nothing: the banner below says
// how the run is doing.

export interface DemoStartApi {
	providers(): Promise<{ demoRepo?: string }>;
	runs(): Promise<{ running: { fullName: string } | null; agentsPerRun?: number }>;
	start(): Promise<{ id: string; repo: string }>;
}

/** Whether to offer a run on `repo`: only the demo repo, and only once the runs are read and none is going. */
export function mayStartDemo(
	repo: string,
	setup: { demoRepo?: string } | undefined,
	runs: { running: unknown } | undefined,
): boolean {
	return !!setup?.demoRepo && setup.demoRepo === repo && !!runs && !runs.running;
}

/** Starts a demo run on the demo repo's Hive tab; nothing on any other repo. */
export function DemoStart({ repo, api, signedIn }: { repo: string; api: DemoStartApi; signedIn: boolean }) {
	const setup = usePoll("demo-start:providers", () => api.providers(), 10 * 60_000);
	const runs = usePoll("demo-start:runs", () => api.runs(), 30_000);
	const [starting, setStarting] = useState(false);
	const [problem, setProblem] = useState<string | null>(null);
	if (!mayStartDemo(repo, setup.data, runs.data)) return null;

	const start = async () => {
		setStarting(true);
		setProblem(null);
		try {
			await api.start();
		} catch (err) {
			setProblem(messageOf(err));
		} finally {
			runs.refresh();
			setStarting(false);
		}
	};
	// The header's own band, so the strip reads as part of the repo's header.
	return (
		<div className="bg-card">
			<section
				aria-labelledby="demo-start-title"
				className={cn(
					"mx-auto flex w-full max-w-(--page-width) animate-fade px-6 pt-4 to-560:px-4",
					"flex-wrap items-center gap-x-4 gap-y-2",
				)}
			>
				<p className="m-0 min-w-0 flex-[1_1_320px] text-ui">
					<strong id="demo-start-title">
						{signedIn ? "Watch this hive build a game." : "Watch this hive build a game, no account needed."}
					</strong>{" "}
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
		</div>
	);
}
