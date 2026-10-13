import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { draftFrom } from "../lib/mergeSettings";
import { BROWSER_CHECK, MergeChecks } from "./MergeChecks";

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

	it("offers to add the browser check until a check runs it", () => {
		expect(shown(["npm test"])).toContain("Add a browser check");
		expect(shown(["npm test", `${BROWSER_CHECK} --page /`])).not.toContain("Add a browser check");
		expect(shown([])).toContain("What the browser check does");
	});
});
