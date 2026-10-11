// Installing a checkout's dependencies in a Gate's container, and the hashes that let an unchanged install be skipped.
import { WORKDIR, clip, installToolchains, run } from "./container";
import type { CheckResult } from "./gate-types";
import { DEPENDENCIES, DEPENDENCY_FILES, type Toolchain } from "./toolchains";

const INSTALLS = /^(npm|pnpm|yarn|bun)\s+(ci|install)(\s|$)/;

/** Whether a check installs a Node project's dependencies. */
export const isInstall = (command: string) => INSTALLS.test(command.trim());

/**
 * Puts an install first in a Node project's checks when none of them installs dependencies, since otherwise every
 * check fails on missing tools. A Bun project's dependencies are installed with its toolchain instead (see
 * toolchains.ts), from its own lockfile.
 */
export function withInstall(
	checks: string[],
	project: { packageJson: boolean; npmLockfile: boolean; bunLockfile?: boolean },
) {
	if (!project.packageJson || project.bunLockfile) return checks;
	if (checks.some((c) => INSTALLS.test(c.trim()))) return checks;
	return [project.npmLockfile ? "npm ci" : "npm install", ...checks];
}

/** The checks with an install first when the checkout is a Node project whose checks don't install. */
export async function checksFor(container: Container, checks: string[]) {
	const found = await run(container, [
		"bash",
		"-c",
		"[ -f package.json ] && echo package.json; [ -f package-lock.json ] || [ -f npm-shrinkwrap.json ] " +
			"&& echo lockfile; [ -f bun.lock ] || [ -f bun.lockb ] && echo bun; true",
	]);
	return withInstall(checks, {
		packageJson: found.output.includes("package.json"),
		npmLockfile: found.output.includes("lockfile"),
		bunLockfile: found.output.includes("bun"),
	});
}

/**
 * Hashes package.json's dependency sections and any lockfile. Without a lockfile every install resolves from the
 * registry again, so skipping an unchanged install matters.
 */
export async function lockHash(container: Container) {
	const deps =
		`node -e 'try { const p = require("./package.json"); console.log(JSON.stringify(["dependencies", ` +
		`"devDependencies", "optionalDependencies", "peerDependencies", "overrides", "resolutions", ` +
		`"workspaces"].map((k) => p[k] ?? null))) } catch { console.log("none") }'`;
	const hashed = await run(container, [
		"bash",
		"-lc",
		`{ ${deps}; cat package-lock.json npm-shrinkwrap.json yarn.lock pnpm-lock.yaml bun.lock bun.lockb 2>/dev/null; } | ` +
			"sha256sum | cut -d' ' -f1",
	]);
	return hashed.output.trim();
}

/** Whether dependencies are installed and match the install that `last` hashed. */
export async function installMatches(container: Container, last: string | undefined) {
	if (!last) return false;
	const installed = await run(container, ["test", "-d", "node_modules"]);
	return installed.exitCode === 0 && (await lockHash(container)) === last;
}

/** Hashes the installed toolchains and the files their dependencies come from. */
async function dependenciesHash(container: Container, installed: { toolchain: Toolchain }[]) {
	const hashed = await run(container, [
		"bash",
		"-c",
		`{ echo ${installed.map((i) => i.toolchain).join(",")}; cat ${DEPENDENCY_FILES} 2>/dev/null; } | ` +
			"sha256sum | cut -d' ' -f1",
	]);
	return hashed.output.trim();
}

/** Toolchain installs that failed, as failed checks. */
function failedToolchains(installed: { toolchain: Toolchain; exitCode: number; output: string }[]) {
	return installed
		.filter((i) => i.exitCode !== 0)
		.map((i) => ({
			command: `install ${i.toolchain}`,
			exitCode: i.exitCode,
			output: clip(i.output, 6_000),
		}));
}

/** An install check reported as skipped. */
export function skippedInstall(command: string): CheckResult {
	return {
		command,
		exitCode: 0,
		output: "Skipped: package.json and its lockfile are unchanged since the last install in this gate.",
	};
}

/** Each toolchain's dependency install, reported as skipped. */
function skippedDependencies(installed: { toolchain: Toolchain }[]): CheckResult[] {
	return installed.map((i) => ({
		command: DEPENDENCIES[i.toolchain].command,
		exitCode: 0,
		output: "Skipped: the files dependencies come from are unchanged since the last install in this gate.",
	}));
}

/** Installs each toolchain's dependencies in turn, stopping at the first that fails. */
async function installDependencies(
	container: Container,
	installed: { toolchain: Toolchain }[],
): Promise<CheckResult[]> {
	const results: CheckResult[] = [];
	for (const { toolchain } of installed) {
		const ran = await run(container, ["bash", "-lc", DEPENDENCIES[toolchain].script], WORKDIR, undefined, 600);
		results.push({ command: DEPENDENCIES[toolchain].command, exitCode: ran.exitCode, output: clip(ran.output, 6_000) });
		if (ran.exitCode !== 0) return results;
	}
	return results;
}

/**
 * Installs the toolchains the checkout uses and their dependencies, skipping dependencies whose source files are
 * unchanged since the install recorded in `storage`. A failed install is returned as a failed check.
 */
export async function setUpToolchains(container: Container, storage: DurableObjectStorage): Promise<CheckResult[]> {
	const installed = await installToolchains(container);
	const failed = failedToolchains(installed);
	if (failed.length) return failed;
	if (!installed.length) return [];
	const hash = await dependenciesHash(container, installed);
	if (hash && (await storage.get<string>("depsHash")) === hash) return skippedDependencies(installed);
	const results = await installDependencies(container, installed);
	if (results.some((r) => r.exitCode !== 0)) return results;
	await storage.put("depsHash", hash);
	return results;
}
