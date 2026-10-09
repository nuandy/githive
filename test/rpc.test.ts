import { describe, expect, it, vi } from "vitest";
import { briefOutage, rpc, rpcRetried } from "../src/rpc";

// RPC results are disposed once read, and a call that failed only because
// its Durable Object or container was briefly away is tried once more.

const reset = () => Object.assign(new Error("Durable Object reset because its code was updated."), { retryable: true });

describe("an RPC result", () => {
	it("is disposed once it's here, and a plain value passes as it is", async () => {
		const dispose = vi.fn();
		const value = { ok: 1, [Symbol.dispose]: dispose };
		expect(await rpc(Promise.resolve(value))).toBe(value);
		expect(dispose).toHaveBeenCalledOnce();
		expect(await rpc(Promise.resolve("plain"))).toBe("plain");
	});
});

describe("an RPC that failed for a brief outage", () => {
	it("is a reset Durable Object or an unavailable container, never an overloaded one or another failure", () => {
		expect(briefOutage(reset())).toBe(true);
		expect(briefOutage(new Error("The container connection is temporarily unavailable, try again shortly"))).toBe(true);
		expect(briefOutage(new Error("internal error; reference = 6p8ol0u6bt9lt3vveg4l3lp2"))).toBe(true);
		expect(briefOutage(Object.assign(new Error("Durable Object is overloaded."), { retryable: true, overloaded: true }))).toBe(false);
		expect(briefOutage(new Error("[409] there's no branch main"))).toBe(false);
	});

	it("is tried once more, and only once", async () => {
		const once = vi.fn().mockRejectedValueOnce(reset()).mockResolvedValueOnce("second");
		expect(await rpcRetried(once, 0)).toBe("second");
		expect(once).toHaveBeenCalledTimes(2);
		const always = vi.fn().mockRejectedValue(reset());
		await expect(rpcRetried(always, 0)).rejects.toThrow(/reset/);
		expect(always).toHaveBeenCalledTimes(2);
		const other = vi.fn().mockRejectedValue(new Error("[409] no"));
		await expect(rpcRetried(other, 0)).rejects.toThrow(/409/);
		expect(other).toHaveBeenCalledOnce();
	});
});
