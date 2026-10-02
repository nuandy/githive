import { DurableObject } from "cloudflare:workers";
import { WORKDIR, bootContainer, clip, gitWithToken, run } from "./container";
import { contractErrors, contractGroups, jsContracts, parseNodeCheck, parseTsc, type TscError } from "./contract-check-plan";

// Checks a planner's contract files before the blueprint is accepted: a
// TypeScript type check, or a syntax check for plain JavaScript. This way
// mistakes like a syntax error in a contract test or a function signature
// without an implementation are fixed by the planner, not discovered later by
// every builder. Other languages aren't checked. One instance per planning run; it keeps its container and
// installed dependencies between the planner's attempts.

export interface ContractCheckJob {
	remote: string;
	token: string;
	commit: string;
	contracts: Record<string, string>;
}

export type ContractCheckResult =
	| { status: "passed"; checked: string[]; unchecked: string[] }
	| { status: "failed"; errors: TscError[]; checked: string[]; unchecked: string[] }
	| { status: "skipped"; reason: string };

const TEMP_CONFIG = "tsconfig.blueprint-contracts.json";

export class ContractChecker extends DurableObject<Env> {
	async check(job: ContractCheckJob): Promise<ContractCheckResult> {
		const container = this.ctx.container;
		if (!container) throw new Error("no container is configured for ContractChecker");
		if (!container.running || (await this.ctx.storage.get<string>("prepared")) !== job.commit) await this.prepare(container, job);
		await container.setInactivityTimeout(15 * 60_000);

		// Start from the clean planned commit; untracked node_modules stays (it's ignored).
		await run(container, ["bash", "-lc", `git checkout -q -f ${job.commit} && git clean -fdq`]);
		for (const [path, content] of Object.entries(job.contracts))
			await run(container, ["bash", "-c", 'mkdir -p "$(dirname "$1")" && cat > "$1"', "write", path], WORKDIR, content);

		const files = Object.keys(job.contracts);
		const errors: TscError[] = [];
		const checked: string[] = [];

		// JavaScript: a syntax check with node (no types to check).
		for (const file of jsContracts(files)) {
			checked.push(file);
			const r = await run(container, ["node", "--check", file]);
			if (r.exitCode !== 0) errors.push(parseNodeCheck(file, r.output) ?? { file, line: 0, code: 0, message: clip(r.output, 500) });
		}

		// TypeScript: tsc with each file's nearest tsconfig.json.
		const tsFiles = files.filter((f) => /\.(ts|tsx|mts|cts)$/.test(f));
		const hasTsc = tsFiles.length > 0 && (await run(container, ["test", "-x", "node_modules/.bin/tsc"])).exitCode === 0;
		const configs = hasTsc ? (await run(container, ["git", "ls-files", "*tsconfig.json"])).output.split("\n").filter(Boolean) : [];
		const { groups } = contractGroups(tsFiles, configs);
		for (const [config, relative] of groups) {
			// Extend the project's own config so contracts get its libraries and
			// global types; `files` adds the contracts even when its `include` doesn't.
			const dir = config.includes("/") ? config.slice(0, config.lastIndexOf("/")) : ".";
			const temp = `${dir}/${TEMP_CONFIG}`;
			const body = JSON.stringify({ extends: "./tsconfig.json", files: relative, compilerOptions: { noEmit: true } });
			await run(container, ["bash", "-c", 'cat > "$1"', "write", temp], WORKDIR, body);
			const out = await run(container, ["node_modules/.bin/tsc", "-p", temp, "--pretty", "false"], WORKDIR, undefined, 300);
			errors.push(...contractErrors(parseTsc(out.output), files));
			checked.push(...relative.map((r) => (dir === "." ? r : `${dir}/${r}`)));
		}

		// Everything else (other languages, JSX, TypeScript with no compiler or config) isn't checked.
		const unchecked = files.filter((f) => !checked.includes(f));
		if (!checked.length)
			return { status: "skipped", reason: tsFiles.length && !hasTsc ? "the project has no TypeScript compiler installed" : "no contract file is JavaScript or TypeScript covered by a tsconfig.json" };
		return errors.length ? { status: "failed", errors, checked, unchecked } : { status: "passed", checked, unchecked };
	}

	/** Planning is over: stop the container. */
	async dispose() {
		await this.ctx.storage.delete("prepared");
		if (this.ctx.container?.running) await this.ctx.container.destroy("contract check done");
	}

	private async prepare(container: Container, job: ContractCheckJob) {
		await bootContainer(container);
		await run(container, ["rm", "-rf", WORKDIR], "/");
		const clone = await gitWithToken(container, job.token, ["clone", "--quiet", job.remote, WORKDIR], "/");
		if (clone.exitCode !== 0) throw new Error(`clone failed: ${clip(clone.output, 2_000)}`);
		await run(container, ["git", "checkout", "-q", job.commit]);
		const install = await run(
			container,
			["bash", "-lc", "if [ -f package-lock.json ]; then npm ci --no-audit --no-fund; elif [ -f package.json ]; then npm install --no-audit --no-fund; fi"],
			WORKDIR,
			undefined,
			600,
		);
		if (install.exitCode !== 0) throw new Error(`installing dependencies failed: ${clip(install.output, 2_000)}`);
		await this.ctx.storage.put("prepared", job.commit);
	}
}
