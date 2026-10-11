import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { RepoSnapshot } from "../api";
import { MergeSettings } from "./MergeSettings";

describe("merge settings", () => {
	it("say what the checks run in: any shell command, the tools there, the limits, and no secrets", () => {
		const snapshot = {
			branch: "main",
			policy: { required: 1, vetoes: [] },
			verify: ["npm test"],
		} as unknown as RepoSnapshot;
		const html = renderToStaticMarkup(<MergeSettings snapshot={snapshot} save={async () => ({}) as never} />);
		expect(html).toContain("<summary>What the checks run in</summary>");
		expect(html).toMatch(/shell command, run with bash at the top of the repo, on main/);
		expect(html).toMatch(/Node 24, npm and git/);
		expect(html).toMatch(/Up to 10 minutes per command/);
		expect(html).toMatch(/No secrets or environment variables/);
	});

	it("say why checks matter while a repo has none, and stop once it has one", () => {
		const settings = (verify: string[]) =>
			({ branch: "main", policy: { required: 1, vetoes: [] }, verify }) as unknown as RepoSnapshot;
		const without = renderToStaticMarkup(<MergeSettings snapshot={settings([])} save={async () => ({}) as never} />);
		expect(without).toMatch(/Without checks, nothing catches two changes that merge cleanly but break together/);
		const withChecks = renderToStaticMarkup(
			<MergeSettings snapshot={settings(["npm test"])} save={async () => ({}) as never} />,
		);
		expect(withChecks).not.toMatch(/Without checks/);
	});
});
