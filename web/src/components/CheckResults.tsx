import type { Change } from "../lib/model";
import { Icon } from "./Icon";
import "./CheckResults.css";

type Gate = NonNullable<Change["gate"]>;

export interface CheckRow {
	command: string;
	state: "passed" | "failed" | "running" | "queued" | "pending";
	exitCode?: number;
	output?: string;
}

/** One row per check command: the repo's commands first, then any others the run reported. */
export function checkRows(verify: string[], gate: Gate | undefined): CheckRow[] {
	const results = Array.isArray(gate?.result?.results) ? gate.result.results : [];
	const commands = [...verify, ...results.map((r) => r.command).filter((command) => !verify.includes(command))];
	return commands.map((command) => {
		const result = results.find((r) => r.command === command);
		if (result) return { command, state: result.exitCode === 0 ? "passed" : "failed", exitCode: result.exitCode, output: result.output };
		if (gate?.status === "running") return { command, state: "running" };
		if (gate?.status === "queued") return { command, state: "queued" };
		return { command, state: "pending" };
	});
}

const ICONS = { passed: "check", failed: "x", running: "loader", queued: "clock", pending: "dot" } as const;
const TONES = { passed: "good", failed: "bad", running: "warn", queued: "warn", pending: "neutral" } as const;
const WORDS = { passed: "passed", failed: "failed", running: "running", queued: "queued", pending: "not run yet" } as const;

/** Check commands with their outcome; failed outputs open by default. */
export function CheckResults({ gate, verify = [], compact = false, branch = "main" }: { gate: Gate | undefined; verify?: string[]; compact?: boolean; branch?: string }) {
	const rows = checkRows(verify, gate);
	const conflicts = Array.isArray(gate?.result?.mergeConflict) ? gate.result.mergeConflict : [];
	return (
		<div className={`check-results${compact ? " check-results--compact" : ""}`}>
			{conflicts.length ? (
				<p className="check-results__conflict tone-bad">
					<Icon name="conflict" size={14} /> Doesn't merge cleanly onto {branch}: {conflicts.join(", ")}
				</p>
			) : null}
			{rows.length ? (
				<ul>
					{rows.map((row) => (
						<li key={row.command} className="check-results__row">
							<details open={!compact && row.state === "failed"}>
								<summary>
									<span className={`tone-${TONES[row.state]}`}>
										<Icon name={ICONS[row.state]} size={14} label={WORDS[row.state]} />
									</span>
									<code>{row.command}</code>
									<span className="muted check-results__state">
										{WORDS[row.state]}
										{row.exitCode !== undefined && row.exitCode !== 0 ? ` (exit ${row.exitCode})` : ""}
									</span>
								</summary>
								{row.output !== undefined ? (
									<pre className="check-results__output" tabIndex={0}>
										{row.output || "(no output)"}
									</pre>
								) : null}
							</details>
						</li>
					))}
				</ul>
			) : null}
		</div>
	);
}
