import { describe, expect, it } from "vitest";
import { humanizeText, mentionsChange } from "./humanize";

describe("humanizeText", () => {
	it("rewords the decision log's internal terms", () => {
		expect(humanizeText("ui integrated into the task base", ["ui"])).toBe("ui merged into main");
		expect(humanizeText("ui pushed abc123: 2 files changed; Merge-ahead: no conflicts", ["ui"])).toBe("ui pushed abc123: 2 files changed; no conflicts");
		expect(humanizeText("Slice ui answered cross-lane request r1", ["ui"])).toBe("Change ui answered cross-claim request r1");
		expect(humanizeText("ui: quorum approved", ["ui"])).toBe("ui: review approved");
		expect(humanizeText("ui: gate failed on base abc", ["ui"])).toBe("ui: checks failed on base abc");
		expect(humanizeText("ui needs a human: stuck", ["ui"])).toBe("ui needs you: stuck");
		expect(humanizeText("Message from service token abc to ui's builder", ["ui"])).toBe("Message from abc to ui's builder");
	});

	it("leaves change ids alone even when they contain those words", () => {
		expect(humanizeText("fix-gate: gate passed", ["fix-gate"])).toBe("fix-gate: checks passed");
		expect(humanizeText("Change slice-view opened", ["slice-view"])).toBe("Change slice-view opened");
		expect(humanizeText("lane sent back", ["lane"])).toBe("lane sent back");
	});
});

describe("mentionsChange", () => {
	it("matches a change id as a whole word, hyphens included", () => {
		expect(mentionsChange("Change add-stats opened", "add-stats")).toBe(true);
		expect(mentionsChange("add-stats: tests reviewer approved", "add-stats")).toBe(true);
		expect(mentionsChange("Change add-stats opened", "add")).toBe(false);
		expect(mentionsChange("Change add-stats-v2 opened", "add-stats")).toBe(false);
		expect(mentionsChange("Message to add-stats's builder", "add-stats")).toBe(true);
	});
});
