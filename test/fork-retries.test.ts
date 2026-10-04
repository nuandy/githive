import { describe, expect, it, vi } from "vitest";

// Waits are instant here; what matters is how many times a fork is asked for.
vi.mock("../src/retry", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/retry")>()), sleep: vi.fn(async () => {}) }));

const { forkAndWait } = await import("../src/artifacts");

const transient = () => Object.assign(new Error("temporarily unavailable"), { status: 503 });
const internal = () => Object.assign(new Error("An internal error occurred."), { code: "INTERNAL_ERROR" });

describe("fork retries", () => {
	it("asks for a fork at most five times however it fails", async () => {
		vi.stubGlobal("scheduler", { wait: vi.fn(async () => {}) });
		const source = { fork: vi.fn().mockRejectedValue(transient()) };
		const artifacts = { get: vi.fn(async () => source) } as never;
		await expect(forkAndWait(artifacts, "source", "fork", "test fork")).rejects.toThrow("temporarily unavailable");
		expect(source.fork).toHaveBeenCalledTimes(5);

		source.fork.mockReset();
		source.fork.mockRejectedValueOnce(transient()).mockRejectedValueOnce(internal()).mockRejectedValue(transient());
		await expect(forkAndWait(artifacts, "source", "fork", "test fork")).rejects.toThrow("temporarily unavailable");
		expect(source.fork).toHaveBeenCalledTimes(5);
		vi.unstubAllGlobals();
	});

	it("uses a fork that a transiently failed request made after all", async () => {
		const exists = Object.assign(new Error("repo fork already exists"), { code: "ALREADY_EXISTS" });
		const source = { fork: vi.fn().mockRejectedValueOnce(transient()).mockRejectedValueOnce(exists) };
		const made = { info: vi.fn(async () => ({ remote: "https://git.test/fork.git" })), createToken: vi.fn(async () => ({ plaintext: "fresh" })) };
		const artifacts = { get: vi.fn(async (name: string) => (name === "source" ? source : made)) } as never;
		await expect(forkAndWait(artifacts, "source", "fork", "test fork")).resolves.toEqual({ name: "fork", remote: "https://git.test/fork.git", token: "fresh" });
	});
});
