import { Icon } from "./Icon";
import type { DraftSectionProps } from "./MergeSettings";

interface MergeChecksProps extends DraftSectionProps {
	branch: string;
}

/** The merge settings' checks: the commands, what they skip, and what they run in. */
export function MergeChecks({ draft, update, busy, branch }: MergeChecksProps) {
	const changeCheck = (index: number, command: string) => {
		const verify = draft.verify.map((current, checkIndex) => (checkIndex === index ? command : current));
		update({ verify });
	};
	const removeCheck = (index: number) =>
		update({ verify: draft.verify.filter((_, checkIndex) => checkIndex !== index) });

	return (
		<section className="box" aria-labelledby="settings-checks">
			<div className="box__header">
				<h2 id="settings-checks">Merge checks</h2>
			</div>
			<div className="box__body repo-settings__fields">
				<p className="muted">
					Commands that must pass on a change merged into {branch} before it lands, run by GitHive in its own container.
					None: a change merges once approved, and no container runs.
				</p>
				{draft.verify.map((command, index) => (
					<div key={index} className="repo-settings__add">
						<label className="sr-only" htmlFor={`check-${index}`}>
							Check {index + 1}
						</label>
						<input
							id={`check-${index}`}
							className="repo-settings__command"
							value={command}
							onChange={(event) => changeCheck(index, event.target.value)}
							placeholder="npm test"
							spellCheck={false}
							disabled={busy}
						/>
						<button
							type="button"
							className="link"
							onClick={() => removeCheck(index)}
							disabled={busy}
							aria-label={`Remove check ${index + 1}`}
						>
							Remove
						</button>
					</div>
				))}
				<div>
					<button type="button" onClick={() => update({ verify: [...draft.verify, ""] })} disabled={busy}>
						<Icon name="plus" />
						Add a check
					</button>
				</div>
				<div className="repo-settings__field">
					<label htmlFor="skip-checks">Skipped for changes that only touch</label>
					<textarea
						id="skip-checks"
						className="repo-settings__command"
						value={draft.skipChecks}
						onChange={(event) => update({ skipChecks: event.target.value })}
						spellCheck={false}
						disabled={busy}
					/>
					<p className="muted">
						One pattern a line: a name (*.md, LICENSE*), a folder anywhere (docs/), or a path from the top
						(site/*.html). A file under test/, fixtures/ or examples/ always runs the checks. Empty: they always run.
					</p>
				</div>
				<CheckEnvironment branch={branch} />
			</div>
		</section>
	);
}

/** What the checks run in: the shell, the tools installed, the limits, and what isn't there. */
function CheckEnvironment({ branch }: { branch: string }) {
	return (
		<details className="repo-settings__details">
			<summary>What the checks run in</summary>
			<p>
				Each check is a shell command, run with bash at the top of the repo, on {branch} with the changes merged in.
				Exit code 0 passes. The first that fails stops the run, and the end of its output is what the change is sent
				back with.
			</p>
			<ul>
				<li>
					Debian, with Node 24, npm and git. Python 3 (with uv), Go and Rust too, when the repo has a pyproject.toml or
					requirements.txt, a go.mod, or a Cargo.toml.
				</li>
				<li>
					Dependencies installed first: npm ci (npm install without a lockfile) unless a check installs them, and
					Python's, Go's and Rust's. Skipped while they're unchanged.
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
