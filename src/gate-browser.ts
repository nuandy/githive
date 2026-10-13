// The browser check in a Gate's container: Chromium, the library that drives it, and the githive-browser-check
// command (src/browser-check/check.mjs), set up when a repo's checks name the command. The repo's snapshot keeps the
// install, so it happens once per repo; the script is written again each time, so a new one takes effect at once.
import script from "./browser-check/check.mjs";
import { clip, run } from "./container";
import type { CheckResult } from "./gate-types";

export const BROWSER_CHECK = "githive-browser-check";
const HOME = "/opt/githive-browser";
const DRIVER = "puppeteer-core@25";

/** Whether a check command runs the browser check, alone or after other commands. */
export const isBrowserCheck = (command: string) => /(^|[\s;&|(])githive-browser-check(\s|$)/.test(command);

const APT = "DEBIAN_FRONTEND=noninteractive apt-get install -y -qq";

// Prints "installed" when it had to install anything, so a setup that only wrote the script reports nothing.
const SET_UP = [
	"set -e",
	`if ! command -v chromium >/dev/null; then apt-get update -qq && ${APT} chromium fonts-liberation >/dev/null; ` +
		"echo installed; fi",
	`mkdir -p ${HOME}`,
	`if [ ! -d ${HOME}/node_modules/puppeteer-core ]; then npm install --silent --no-audit --no-fund ` +
		`--prefix ${HOME} ${DRIVER} >/dev/null; echo installed; fi`,
	`cat > ${HOME}/check.mjs`,
	`printf '#!/bin/sh\\nexec node ${HOME}/check.mjs "$@"\\n' > /usr/local/bin/${BROWSER_CHECK}`,
	`chmod +x /usr/local/bin/${BROWSER_CHECK}`,
].join("\n");

/**
 * Sets up the browser check if any of `checks` runs it. Returns the install as a check result when one ran, so a
 * failed install fails the checks with its output, and nothing when everything was there already.
 */
export async function setUpBrowserCheck(container: Container, checks: string[]): Promise<CheckResult[]> {
	if (!checks.some(isBrowserCheck)) return [];
	const ran = await run(container, ["bash", "-lc", SET_UP], "/", script, 600);
	const install = {
		command: "install the browser check (Chromium and puppeteer-core)",
		exitCode: ran.exitCode,
		output: clip(ran.output, 6_000),
	};
	if (ran.exitCode !== 0) return [install];
	return ran.output.includes("installed") ? [install] : [];
}
