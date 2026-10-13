// The browser check in a Gate's container: Chromium, the library that drives it, and the githive-browser-check
// command (src/browser-check/check.mjs), set up when a repo's checks name the command. A check only writes the script
// and the command, which installs Chromium the first time it really runs: a check that skips it (a page not yet
// wired up) costs nothing. The repo's warm-up installs it ahead, and its snapshot keeps it, so it happens once per
// repo. The script is written again each time, so a new one takes effect at once.
import script from "./browser-check/check.mjs";
import { clip, run } from "./container";
import type { CheckResult } from "./gate-types";

export const BROWSER_CHECK = "githive-browser-check";
const HOME = "/opt/githive-browser";
const DRIVER = "puppeteer-core@25";

/** What the command prints when it installs Chromium, so the Gate knows to refresh the repo's snapshot. */
export const INSTALLING_NOTE = "Installing Chromium for the browser check, once for this repo";

/** Whether a check command runs the browser check, alone or after other commands. */
export const isBrowserCheck = (command: string) => /(^|[\s;&|(])githive-browser-check(\s|$)/.test(command);

const APT = "DEBIAN_FRONTEND=noninteractive apt-get install -y -qq";

// Installs what's missing, saying so; idempotent.
const INSTALL = [
	"if ! command -v chromium >/dev/null || [ ! -d " + HOME + "/node_modules/puppeteer-core ]; then",
	`  echo "${INSTALLING_NOTE}"`,
	`  command -v chromium >/dev/null || { apt-get update -qq && ${APT} chromium fonts-liberation >/dev/null; }`,
	`  [ -d ${HOME}/node_modules/puppeteer-core ] || npm install --silent --no-audit --no-fund --prefix ${HOME} ` +
		`${DRIVER} >/dev/null`,
	"fi",
].join("\n");

const COMMAND = ["#!/bin/sh", "set -e", INSTALL, `exec node ${HOME}/check.mjs "$@"`, ""].join("\n");

// Writes the script (from stdin) and the command, which installs on its first real run.
const WRITE = [
	"set -e",
	`mkdir -p ${HOME}`,
	`cat > ${HOME}/check.mjs`,
	`cat > /usr/local/bin/${BROWSER_CHECK} <<'COMMAND'`,
	COMMAND + "COMMAND",
	`chmod +x /usr/local/bin/${BROWSER_CHECK}`,
].join("\n");

/**
 * Writes the browser check into the container if any of `checks` runs it, without installing Chromium. A failed write
 * is returned as a failed check.
 */
export async function setUpBrowserCheck(container: Container, checks: string[]): Promise<CheckResult[]> {
	if (!checks.some(isBrowserCheck)) return [];
	const ran = await run(container, ["bash", "-lc", WRITE], "/", script, 60);
	if (ran.exitCode === 0) return [];
	return [{ command: "set up the browser check", exitCode: ran.exitCode, output: clip(ran.output, 6_000) }];
}

/** For a warm-up: sets the browser check up and installs Chromium now, so the repo's snapshot keeps it. */
export async function installBrowserCheck(container: Container, checks: string[]) {
	if (!checks.some(isBrowserCheck)) return;
	await setUpBrowserCheck(container, checks);
	await run(container, ["bash", "-lc", ["set -e", INSTALL].join("\n")], "/", undefined, 600);
}

/** Whether a check run installed Chromium, which the repo's snapshot doesn't have yet. */
export const installedBrowser = (results: CheckResult[]) =>
	results.some((result) => result.output.includes(INSTALLING_NOTE));
