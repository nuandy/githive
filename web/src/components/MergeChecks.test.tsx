import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { draftFrom } from "../lib/mergeSettings";
import { MergeChecks } from "./MergeChecks";

describe("the merge checks", () => {
	const shown = (verify: string[]) =>
		renderToStaticMarkup(
			<MergeChecks
				draft={draftFrom({ required: 0, vetoes: [] }, verify)}
				update={() => undefined}
				busy={false}
				branch="main"
			/>,
		);

	it("lists the checks with a way to add one, and says what they run in", () => {
		const html = shown(["npm test"]);
		expect(html).toContain('value="npm test"');
		expect(html).toContain("Add a check");
		expect(html).toContain("What the checks run in");
		expect(html).not.toMatch(/browser check|Chromium/i);
	});
});
