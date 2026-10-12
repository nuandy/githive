import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { historyFixture, repoSnapshot as snapshot, stubApi } from "../test/fixtures";
import { ChangePage } from "./RepoTabs";
import { RepoPage } from "./RepoPage";

// A public repo's site, and each change's version of it, one click from its pages. A private repo's isn't served,
// so it has no link.

const access = (visibility: "public" | "private") => ({
	id: "acme--docs-site",
	fullName: "acme/docs-site",
	level: "read" as const,
	visibility,
});

describe("a repo's site", () => {
	it("is linked from a public repo's header, in a tab of its own, and not from a private one's", () => {
		const page = (visibility: "public" | "private") =>
			renderToStaticMarkup(
				<RepoPage
					repo="acme/docs-site"
					view={{ kind: "repo", tab: "changes" }}
					snapshot={snapshot}
					api={stubApi()}
					access={access(visibility)}
				/>,
			);
		expect(page("public")).toMatch(/<a class="site-link" href="\/site\/acme\/docs-site\/" target="_blank"[^>]*>/);
		expect(page("public")).toContain("View site");
		expect(page("private")).not.toContain("site-link");
	});

	it("is previewed as a change has it, once something's pushed, only where the repo's is served", () => {
		const page = (previewable: boolean) =>
			renderToStaticMarkup(
				<ChangePage
					snapshot={snapshot}
					changeId="c-1"
					claim={snapshot.claims[0]}
					history={historyFixture}
					repo="acme/docs-site"
					tab="conversation"
					previewable={previewable}
				/>,
			);
		expect(page(true)).toMatch(/href="\/site\/acme\/docs-site\/@c-1\/"[^>]*>.*Preview/);
		expect(page(false)).not.toContain("site-link");
	});
});
