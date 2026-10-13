import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { MyOrg } from "../api";
import { visibleText } from "../test/fixtures";
import { SOURCES } from "./NewRepoFields";
import { NewRepoView, fieldOfError, whatsMissing } from "./NewRepoPage";

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

describe("a new repository's form, as it's filled in", () => {
	const view = (props: Partial<Parameters<typeof NewRepoView>[0]> = {}) =>
		renderToStaticMarkup(<NewRepoView orgs={orgs} repos={[]} create={create} onCreated={() => {}} {...props} />);
	const nameInput = (html: string) => html.match(/<input[^>]*id="new-repo-name"[^>]*>/)?.[0] ?? "";

	it("links the name to its hint, and marks it invalid only while something's wrong", () => {
		const fine = view({ initial: { name: "widgets" } });
		expect(nameInput(fine)).toContain('aria-describedby="new-repo-name-hint"');
		expect(nameInput(fine)).not.toContain("aria-invalid");
		expect(visibleText(fine)).toContain("It will be ada/widgets.");
		const spaced = view({ initial: { name: "my project" } });
		expect(nameInput(spaced)).toContain('aria-invalid="true"');
		expect(visibleText(spaced)).toContain("allowed. Use my-project?");
	});

	it("says a name that's taken under the name, with a way to open the one there", () => {
		const html = view({
			initial: { name: "widgets", serverError: { field: "name", status: 409, text: "ada/widgets exists" } },
		});
		expect(nameInput(html)).toContain('aria-invalid="true"');
		const hint = html.slice(html.indexOf('id="new-repo-name-hint"'));
		expect(visibleText(hint)).toContain("ada/widgets already exists. Choose another name, or open it");
		expect(hint).toContain('href="#/repos/ada/widgets"');
	});

	it("puts an import's failure under its URL, as a sentence", () => {
		const html = view({
			initial: {
				name: "widgets",
				source: "import",
				url: "https://g.test/x",
				serverError: { field: "url", status: 400, text: "the repository has no branch to import" },
			},
		});
		const url = html.match(/<input[^>]*id="new-repo-url"[^>]*>/)?.[0] ?? "";
		expect(url).toContain('aria-invalid="true"');
		expect(url).toContain('aria-describedby="new-repo-url-hint"');
		expect(visibleText(html)).toContain("The repository has no branch to import.");
	});
});

describe("where a server's error goes in the form", () => {
	it("goes to the field it's about, else under what the form started from", () => {
		expect(fieldOfError(409, "ada/widgets exists", "empty")).toBe("name");
		expect(fieldOfError(400, "a repo's name is letters, digits, dots", "import")).toBe("name");
		expect(fieldOfError(403, "you can't make repos in acme", "empty")).toBe("owner");
		expect(fieldOfError(404, "no org acme", "copy")).toBe("owner");
		expect(fieldOfError(400, "not a URL: x", "import")).toBe("url");
		expect(fieldOfError(404, "no repo acme/old", "copy")).toBe("copy");
		expect(fieldOfError(500, "500 Internal Server Error", "empty")).toBe("form");
		expect(fieldOfError(undefined, "Failed to fetch", "empty")).toBe("form");
	});
});
