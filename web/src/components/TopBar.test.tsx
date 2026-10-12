import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { visibleText } from "../test/fixtures";
import { TopBar } from "./TopBar";

// The top bar for someone signed out, reading a public repo, and for someone signed in.

describe("the top bar, signed out", () => {
	it("offers to sign in instead of an inbox", () => {
		const text = visibleText(
			renderToStaticMarkup(<TopBar crumbs={[{ label: "acme/docs" }]} onSignIn={() => undefined} />),
		);
		expect(text).toContain("Sign in");
		expect(text).not.toContain("Inbox");
	});

	it("keeps the inbox for someone signed in", () => {
		const text = visibleText(renderToStaticMarkup(<TopBar crumbs={[]} inboxCount={2} />));
		expect(text).toContain("Inbox");
		expect(text).not.toContain("Sign in");
	});
});

describe("the top bar, signed in", () => {
	const me = {
		kind: "user" as const,
		handle: "ada",
		name: "Ada",
		email: "ada@example.com",
		avatarUrl: null,
		by: "person:ada",
	};

	it("links to the person's agents in plain sight, outside their menu", () => {
		const html = renderToStaticMarkup(<TopBar crumbs={[]} me={me} onSignOut={() => undefined} />);
		const outsideMenu = html.slice(0, html.indexOf('class="usermenu"'));
		expect(outsideMenu).toContain('aria-label="Your agents"');
		expect(visibleText(outsideMenu)).toContain("Agents");
	});

	it("shows no agents link to an admin through Access, who has no agents of their own", () => {
		const access = { kind: "access" as const, label: "admin", by: "access:admin" };
		expect(renderToStaticMarkup(<TopBar crumbs={[]} me={access} />)).not.toContain("Your agents");
	});
});
