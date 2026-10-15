import { describe, expect, it } from "vitest";
import worker from "../src/index";

// Anyone may start a demo run, signed in or not, so a judge or visitor sees a hive at work. The limits are the
// registry's: one at a time, up to 100 a day.

/** A Worker env whose demo registry notes what it was asked, and grants a run unless `refused` says why not. */
function demoEnv(refused?: string) {
	const asked: { reserve?: Record<string, unknown>; begin?: Record<string, unknown> } = {};
	const registry = {
		reserve: async (input: Record<string, unknown>) => {
			asked.reserve = input;
			if (refused) return { refused };
			return { slot: { id: "run-7", number: 7, fullName: "ada/honeycomb", since: 0 } };
		},
	};
	const run = { begin: async (input: Record<string, unknown>) => void (asked.begin = input) };
	const env = {
		DEMO_REPO: "ada/honeycomb",
		DEMO_RUN: { getByName: (name: string) => (name === "registry" ? registry : run) },
	};
	return { env, asked };
}

const startRun = (env: object) =>
	worker.fetch(new Request("https://githive.test/demo/runs", { method: "POST" }), env as never, {} as never);

describe("a visitor starting a demo run", () => {
	it("starts one without signing in, named as a visitor", async () => {
		const { env, asked } = demoEnv();

		const response = await startRun(env);

		expect(response.status).toBe(201);
		expect(asked.begin?.by).toBe("a visitor");
	});

	it("is told why when the registry won't start one, such as a run going already", async () => {
		const { env } = demoEnv("a demo run is going already: watch it at ada/honeycomb");

		const response = await startRun(env);

		expect(response.status).toBe(429);
		expect(((await response.json()) as { error: string }).error).toMatch(/going already/);
	});
});
