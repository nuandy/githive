import { describe, expect, it } from "vitest";
import { applyPatch, diff, fromDoc, ledgerMessage, noteLine, patchOf, replay, toDoc } from "../src/ledger";
import { slice, task } from "./fakes/env";

describe("merge patches", () => {
	it("round-trips nested changes, additions and removals", () => {
		const a = { x: 1, nested: { keep: "k", drop: "d", list: [1, 2] }, gone: true };
		const b = { x: 2, nested: { keep: "k", list: [1, 2, 3], added: { deep: 1 } }, fresh: "f" };
		const patch = diff(a, b);
		expect(patch).toEqual({ x: 2, nested: { drop: null, list: [1, 2, 3], added: { deep: 1 } }, gone: null, fresh: "f" });
		expect(applyPatch(a, patch!)).toEqual(b);
	});

	it("reports no change for equal values", () => {
		expect(diff({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] })).toBeUndefined();
	});
});

describe("the task document", () => {
	it("leaves out scheduling and keys lists by id", () => {
		const t = task({ slices: [slice("a"), slice("b")], queue: [{ kind: "builder", slice: "b" }], active: { builders: ["a"], reviewers: [] } });
		const doc = toDoc(t, { "src/api.ts": "export {}" });
		expect(Object.keys(doc.slices)).toEqual(["a", "b"]);
		expect(doc.task).not.toHaveProperty("queue");
		const back = fromDoc(doc);
		expect(back.task).toEqual({ ...JSON.parse(JSON.stringify(t)), queue: [], active: { builders: [], reviewers: [] } });
		expect(back.contracts).toEqual({ "src/api.ts": "export {}" });
	});

	it("rebuilds the latest state by replaying commit messages in order", () => {
		const t1 = task({ slices: [slice("a"), slice("b")] });
		const t2 = task({ slices: [slice("a", { status: "integrated", reviewHead: "h1" }), slice("b")], phase: "building" });
		const t3 = task({ slices: [slice("a", { status: "integrated", reviewHead: "h1" })], phase: "landed" });
		const docs = [toDoc(t1, {}), toDoc(t2, {}), toDoc(t3, { "x.ts": "1" })];
		const messages = docs.map((d, i) => ledgerMessage([{ commit: "c", text: `step ${i}`, at: "" }], diff(i ? docs[i - 1] : {}, d)));
		expect(replay(messages)).toEqual(docs[2]);
	});
});

describe("notes", () => {
	it("puts the decisions in the message and the patch in a trailer", () => {
		const message = ledgerMessage([{ commit: "c", text: "a: tests reviewer approved: looks good\nmore", at: "" }], { task: { phase: "building" } });
		expect(message.split("\n")[0]).toBe("a: tests reviewer approved: looks good");
		expect(patchOf(message)).toEqual({ task: { phase: "building" } });
	});

	it("timestamps each line and indents continuation lines", () => {
		expect(noteLine({ commit: "c", text: "sent back\nfix the test", at: "2026-10-02T13:20:55.123Z" })).toBe("2026-10-02 13:20:55Z  sent back\n    fix the test");
	});
});
