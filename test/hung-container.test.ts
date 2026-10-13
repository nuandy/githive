import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ContainerUnresponsive, run } from "../src/container";

// A command whose container crashed or hung never comes back, and its limit is minutes away. While a command runs,
// its container is checked on with a quick command: a busy one still answers.

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const never = () => new Promise<never>(() => undefined);
const after = (ms: number) =>
	new Promise<{ exitCode: number; stdout: Uint8Array }>((resolve) =>
		setTimeout(() => resolve({ exitCode: 0, stdout: new TextEncoder().encode("ok") }), ms),
	);

/** A container whose command comes back as `command` says, and whose quick checks answer or not. */
function container(command: () => Promise<{ exitCode: number; stdout: Uint8Array }>, answers: boolean) {
	return {
		exec: vi.fn(async (cmd: string[]) => ({
			output: cmd[0] === "true" ? (answers ? async () => ({ exitCode: 0, stdout: new Uint8Array() }) : never) : command,
		})),
	} as never;
}

it("gives up on a container that stops answering, well before the command's limit", async () => {
	const ran = run(container(never, false), ["npm", "test"], "/work", undefined, 300);
	const outcome = ran.catch((err: unknown) => err);
	await vi.advanceTimersByTimeAsync(75_000);
	expect(await outcome).toBeInstanceOf(ContainerUnresponsive);
});

it("waits for a long command while its container still answers", async () => {
	const ran = run(
		container(() => after(200_000), true),
		["npm", "test"],
		"/work",
		undefined,
		300,
	);
	await vi.advanceTimersByTimeAsync(200_000);
	expect(await ran).toEqual({ exitCode: 0, output: "ok" });
});

it("gives up on a command that never comes back once it's well past its limit, though the container answers", async () => {
	const ran = run(container(never, true), ["npm", "test"], "/work", undefined, 60);
	let ended = false;
	const outcome = ran.catch((err: unknown) => err).finally(() => (ended = true));
	await vi.advanceTimersByTimeAsync(60_000);
	expect(ended).toBe(false);
	await vi.advanceTimersByTimeAsync(60_000);
	expect(await outcome).toBeInstanceOf(ContainerUnresponsive);
});
