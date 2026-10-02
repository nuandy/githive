import { describe, expect, it, vi } from "vitest";
import { FakeStorage, fakeEnv, slice, task } from "../fakes/env";

vi.mock("../../src/artifacts", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../src/artifacts")>()),
	headOf: vi.fn(async () => undefined),
	remoteFor: vi.fn(async (_artifacts: unknown, repo: string) => ({ url: `https://git.test/${repo}.git`, token: "token" })),
}));
vi.mock("../../src/ledger-git", () => ({ appendLedger: vi.fn(async () => undefined), readLedger: vi.fn(async () => []) }));

const { Coordinator } = await import("../../src/coordinator");

describe("late review findings", () => {
	it("surfaces a rejection received after integration without reopening the slice", async () => {
		const storage = new FakeStorage();
		const fake = fakeEnv();
		await storage.put("task", task({ slices: [slice("a", { status: "integrated", reviewHead: "h1" })] }));
		const coordinator = new Coordinator({ storage } as never, fake.env as never);

		await coordinator.submitReview("a", {
			reviewer: "security",
			head: "h1",
			verdict: "reject",
			summary: "Authorization is missing on the new route.",
			evidence: "POST /private succeeds without a token",
		});

		const saved = (await storage.get<ReturnType<typeof task>>("task"))!;
		expect(saved.slices[0].status).toBe("integrated");
		expect(saved.slices[0].reviews.at(-1)).toMatchObject({ verdict: "reject", reviewer: "security" });
		expect(saved.slices[0].attention).toContain("Authorization is missing on the new route.");
		expect(saved.slices[0].attention).toContain("POST /private succeeds without a token");
	});
});
