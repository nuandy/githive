import { cn } from "../lib/utils";
import { Icon } from "./Icon";
import type { DraftSectionProps } from "./MergeSettings";
import { COMMAND, problemsFor, SETTINGS_FIELDS, SettingField, SettingHint } from "./SettingsParts";
import { Callout } from "./ui/box";
import { Button } from "./ui/button";
import { Input, Label, Textarea } from "./ui/field";

interface MergeChecksProps extends DraftSectionProps {
	branch: string;
}

/** The merge settings' checks: the commands, what they skip, and what they run in. */
export function MergeChecks({ draft, update, busy, branch, problems = [] }: MergeChecksProps) {
	const skip = problemsFor(problems, "skip-checks", "skip-checks-hint");
	const changeCheck = (index: number, command: string) => {
		const verify = draft.verify.map((current, checkIndex) => (checkIndex === index ? command : current));
		update({ verify });
	};
	const removeCheck = (index: number) =>
		update({ verify: draft.verify.filter((_, checkIndex) => checkIndex !== index) });

	return (
		<div className={cn(SETTINGS_FIELDS, "px-0.5 py-4")}>
			{draft.verify.some((command) => command.trim()) ? null : <NoChecksHint />}
			{draft.verify.map((command, index) => (
				<div key={index} className="flex min-w-0 items-center gap-2">
					<label className="sr-only" htmlFor={`check-${index}`}>
						Check {index + 1}
					</label>
					<Input
						id={`check-${index}`}
						className={cn(COMMAND, "max-w-105 flex-1")}
						value={command}
						onChange={(event) => changeCheck(index, event.target.value)}
						placeholder="npm test"
						spellCheck={false}
						disabled={busy}
					/>
					<Button
						variant="link"
						onClick={() => removeCheck(index)}
						disabled={busy}
						aria-label={`Remove check ${index + 1}`}
					>
						Remove
					</Button>
				</div>
			))}
			<div className="flex flex-wrap gap-1">
				<Button onClick={() => update({ verify: [...draft.verify, ""] })} disabled={busy}>
					<Icon name="plus" />
					Add a check
				</Button>
			</div>
			<SettingField>
				<Label htmlFor="skip-checks">Skipped for changes that only touch</Label>
				<Textarea
					id="skip-checks"
					className={cn(COMMAND, "leading-[1.45]")}
					value={draft.skipChecks}
					onChange={(event) => update({ skipChecks: event.target.value })}
					spellCheck={false}
					disabled={busy}
					{...skip.attrs}
				/>
				{skip.line}
				<SettingHint id="skip-checks-hint">
					One pattern a line: a name (*.md, LICENSE.*), a folder anywhere (docs/) or at the top (/docs/), or a path from
					the top (site/*.html). A file under test/, fixtures/ or examples/ always runs the checks. Empty: they always
					run.
				</SettingHint>
			</SettingField>
			<CheckEnvironment branch={branch} />
		</div>
	);
}

/** A note under the checks that unfolds: a quiet rule above it, its summary muted. */
const MORE = cn(
	"disclosure mt-4 border-t border-border pt-3",
	"[&>summary]:cursor-pointer [&>summary]:font-medium [&>summary]:text-muted-foreground",
	"[&_p]:my-2 [&_ul]:my-0 [&_ul]:list-disc [&_ul]:pl-5 [&_li]:my-1 [&_li]:wrap-anywhere",
);

/** Why a repo with agents working in parallel wants checks, shown while it has none. */
function NoChecksHint() {
	return (
		<Callout tone="warn" className="block">
			Without checks, nothing catches two changes that merge cleanly but break together, like one agent renaming a
			function while another adds a call to its old name. A build or a typecheck catches most of these:{" "}
			<code>npm run build</code>, <code>npx tsc --noEmit</code>, <code>go build ./...</code> or <code>cargo check</code>
			.
		</Callout>
	);
}

/** What the checks run in: the shell, the tools installed, the limits, and what isn't there. */
function CheckEnvironment({ branch }: { branch: string }) {
	return (
		<details className={MORE}>
			<summary>What the checks run in</summary>
			<p>
				Each check is a shell command, run with bash at the top of the repo, on {branch} with the changes merged in.
				Exit code 0 passes. The first that fails stops the run, and the end of its output is what the change is sent
				back with.
			</p>
			<ul>
				<li>
					Debian, with Node 24, npm and git. Python 3 (with uv), Go, Rust and Bun too, when the repo has a
					pyproject.toml or requirements.txt, a go.mod, a Cargo.toml, or a bun.lock.
				</li>
				<li>
					Dependencies installed first: npm ci (npm install without a lockfile) unless a check installs them, or bun
					install for a Bun repo, and Python's, Go's and Rust's. Skipped while they're unchanged.
				</li>
				<li>
					Up to 10 minutes per command, in 1 vCPU and 3 GiB of memory (2 vCPU and 6 GiB once checks run out of memory).
				</li>
				<li>No secrets or environment variables: a test that needs a database or an API key fails.</li>
				<li>
					Nothing else: Java, .NET, Ruby and Swift aren't installed, and iOS apps can't be built. A command can install
					what it needs itself, as in <code>corepack enable &amp;&amp; pnpm test</code>.
				</li>
			</ul>
			<p>
				For example: <code>npm test</code>, <code>npm run lint</code>, <code>npx tsc --noEmit</code>,{" "}
				<code>pytest -q</code>, <code>go test ./...</code>, <code>cargo test</code>.
			</p>
		</details>
	);
}
