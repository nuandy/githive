import { execFile, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { type AddressInfo, createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	INSTALLING_NOTE,
	installBrowserCheck,
	installedBrowser,
	isBrowserCheck,
	setUpBrowserCheck,
} from "../src/gate-browser";

// The browser check: githive-browser-check opens a site in Chromium and fails on errors and on buttons that do
// nothing. The Gate sets it up in a check container when a repo's checks name it.

const SCRIPT = fileURLToPath(new URL("../src/browser-check/check.mjs", import.meta.url));
const SITE = fileURLToPath(new URL("./fixtures/browser-check/", import.meta.url));
const CHROME = [
	process.env.GITHIVE_CHROMIUM,
	"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
	"/usr/bin/chromium",
	"/usr/bin/google-chrome",
].find((path) => path && existsSync(path));

/** A port nothing listens on, so the app can't land on another test's server. */
function freePort(): Promise<string> {
	return new Promise((done) => {
		const server = createServer().listen(0, "127.0.0.1", () => {
			const { port } = server.address() as AddressInfo;
			server.close(() => done(String(port)));
		});
	});
}

/** Runs the check in the fixture site, and returns its exit code and output. */
function check(...args: string[]): Promise<{ code: number; output: string }> {
	return new Promise((done) => {
		const env = { ...process.env, GITHIVE_CHROMIUM: CHROME };
		execFile("node", [SCRIPT, ...args], { cwd: SITE, env, timeout: 120_000 }, (error, stdout) => {
			const code = error ? Number((error as { code?: number }).code ?? 1) : 0;
			done({ code, output: stdout });
		});
	});
}

describe.skipIf(!CHROME)("the browser check in Chromium", { timeout: 150_000 }, () => {
	it("fails on a button that does nothing, an error a click throws, and a page that loads with errors", async () => {
		const { code, output } = await check("--page", "/", "--page", "/broken.html");
		expect(code).toBe(1);
		const problems = output.split("\n").filter((line) => line.startsWith("- "));
		// A page's console errors and failed files can come in either order.
		expect(problems).toHaveLength(4);
		expect(problems).toEqual(
			expect.arrayContaining([
				'- /: clicking button#throws "Share" caused uncaught error: share is broken',
				expect.stringMatching(/^- \/: clicking button#dead "Yesterday" changed nothing on the page, also after/),
				"- /broken.html: console error: boom on load",
				expect.stringMatching(/^- \/broken\.html: http:\/\/127\.0\.0\.1:\d+\/missing\.js answered 404$/),
			]),
		);
		// Delete works once a letter is typed, the dialog counts as a change, and the marked button is left alone.
		expect(problems.join("\n")).not.toMatch(/Delete|clicking button#help|Copy/);
	});

	it("passes a clean page, and checks an app its start command runs", async () => {
		expect(await check("--page", "/clean.html")).toMatchObject({ code: 0, output: expect.stringMatching(/passed/) });
		const port = await freePort();
		const app = await check("--start", `node serve.mjs ${port}`, "--url", `http://127.0.0.1:${port}/`);
		expect(app).toEqual({
			code: 0,
			output: "browser check passed: 1 page, 1 clickable, each did something, no errors\n",
		});
	});

	it("lets a page copy on a click, as a person's browser does, and still fails a copy nothing shows", async () => {
		const { code, output } = await check("--page", "/copy.html");
		expect(code).toBe(1);
		expect(output.split("\n").filter((line) => line.startsWith("- "))).toEqual([
			expect.stringMatching(/^- \/copy\.html: clicking button#silent "Copy link" changed nothing on the page/),
		]);
	});

	it("says what's wrong with its options", async () => {
		expect(await check("--start", "npm run dev")).toEqual({
			code: 2,
			output: "githive-browser-check: --start needs --url, where the app answers\n",
		});
	});
});

/** A container that answers every command with `answer`, recording what ran and what it was given. */
function fakeContainer(answer: { exitCode: number; output: string }) {
	const ran: { cmd: string[]; stdin: unknown }[] = [];
	const container = {
		running: true,
		exec: async (cmd: string[], options: { stdin?: unknown } = {}) => {
			ran.push({ cmd: cmd.slice(4), stdin: options.stdin });
			return {
				output: async () => ({ exitCode: answer.exitCode, stdout: new TextEncoder().encode(answer.output) }),
			};
		},
	};
	return { container: container as unknown as Container, ran };
}

describe("setting up the browser check in a Gate", () => {
	it("knows the command alone or after others, and not inside another name", () => {
		expect(isBrowserCheck("githive-browser-check")).toBe(true);
		expect(isBrowserCheck("cd site && githive-browser-check --page /")).toBe(true);
		expect(isBrowserCheck("npm test")).toBe(false);
		expect(isBrowserCheck("my-githive-browser-check")).toBe(false);
	});

	it("writes the command for checks that run it, leaving Chromium to the command's first real run", async () => {
		const quiet = fakeContainer({ exitCode: 0, output: "" });
		expect(await setUpBrowserCheck(quiet.container, ["npm test"])).toEqual([]);
		expect(quiet.ran).toHaveLength(0);
		const skipped = 'grep -q "is being built" src/main.js || githive-browser-check';
		expect(await setUpBrowserCheck(quiet.container, ["npm test", skipped])).toEqual([]);
		const [written] = quiet.ran;
		expect(written!.cmd.slice(0, 2)).toEqual(["bash", "-lc"]);
		execFileSync("bash", ["-n", "-c", written!.cmd[2]!]);
		expect(written!.cmd[2]).not.toMatch(/^apt-get/m);
		const failed = fakeContainer({ exitCode: 1, output: "No space left on device" });
		expect(await setUpBrowserCheck(failed.container, ["githive-browser-check"])).toMatchObject([
			{ command: "set up the browser check", exitCode: 1 },
		]);
	});

	it("installs ahead on a warm-up, and knows a check that had to install", async () => {
		const warm = fakeContainer({ exitCode: 0, output: "" });
		await installBrowserCheck(warm.container, ["githive-browser-check"]);
		expect(warm.ran).toHaveLength(2);
		execFileSync("bash", ["-n", "-c", warm.ran[1]!.cmd[2]!]);
		const result = (output: string) => ({ command: "githive-browser-check", exitCode: 0, output });
		expect(installedBrowser([result(`${INSTALLING_NOTE}\nbrowser check passed`)])).toBe(true);
		expect(installedBrowser([result("browser check passed")])).toBe(false);
	});
});
