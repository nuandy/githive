import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { MyOrg } from "../api";
import { visibleText } from "../test/fixtures";
import { SOURCES } from "./NewRepoFields";
import { NewRepoView, whatsMissing } from "./NewRepoPage";

const orgs: MyOrg[] = [
	{
		id: "p",
		slug: "ada",
		name: null,
		personal: true,
		defaultPermission: "admin",
		membersCanCreateRepos: false,
		role: "owner",
	},
];
const create = async () => ({}) as never;

describe("a new repository's form", () => {
	it("starts fresh, with the choices in the order people pick them", () => {
		expect(SOURCES.map((source) => source.value)).toEqual(["empty", "import", "copy"]);
		const html = renderToStaticMarkup(<NewRepoView orgs={orgs} repos={[]} create={create} onCreated={() => {}} />);
		expect(html).toMatch(/value="empty"[^>]*checked|checked[^>]*value="empty"/);
	});

	it("says what the form still needs while it can't be sent", () => {
		const html = renderToStaticMarkup(<NewRepoView orgs={orgs} repos={[]} create={create} onCreated={() => {}} />);
		expect(visibleText(html)).toContain("Name it to make it.");
		const submit = html.match(/<button[^>]*type="submit"[^>]*>/)?.[0] ?? "";
		expect(submit).toContain('disabled=""');
		expect(submit).toContain('aria-describedby="new-repo-missing"');
		expect(html).toContain('id="new-repo-missing"');
	});

	it("names the one thing missing, for each way to start", () => {
		const form = { name: "web", source: "empty" as const, url: "", copyFrom: "" };
		expect(whatsMissing({ ...form, name: " " })).toBe("Name it to make it.");
		expect(whatsMissing({ ...form, name: "-web" })).toBe("Fix the name to make it.");
		expect(whatsMissing({ ...form, source: "import" })).toBe("Add the Git URL to import.");
		expect(whatsMissing({ ...form, source: "import", url: "https://g.test/x" })).toBeNull();
		expect(whatsMissing({ ...form, source: "copy" })).toBe("Choose the repository to copy.");
		expect(whatsMissing({ ...form, source: "copy", copyFrom: "acme/old" })).toBeNull();
		expect(whatsMissing(form)).toBeNull();
	});
});
