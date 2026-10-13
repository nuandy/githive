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
		const menuAt = html.indexOf('aria-label="Signed in as ada"');
		expect(menuAt).toBeGreaterThan(0);
		const outsideMenu = html.slice(0, menuAt);
		expect(outsideMenu).toContain('aria-label="Your agents"');
		expect(visibleText(outsideMenu)).toContain("Your agents");
	});

	it("shows no agents link to an admin through Access, who has no agents of their own", () => {
		const access = { kind: "access" as const, label: "admin", by: "access:admin" };
		expect(renderToStaticMarkup(<TopBar crumbs={[]} me={access} />)).not.toContain("Your agents");
	});

	it("keeps an admin's Admin link beside the Inbox, at the right", () => {
		const access = { kind: "access" as const, label: "admin", by: "access:admin" };
		const markup = renderToStaticMarkup(<TopBar crumbs={[]} me={access} />);
		// Only the Inbox takes the free space; the links after it don't take a share of it.
		const tag = (label: string) => markup.match(new RegExp(`<a [^>]*aria-label="${label}"[^>]*>`))?.[0] ?? "";
		expect(tag("Inbox")).toMatch(/\bml-auto\b/);
		expect(tag("Admin")).not.toBe("");
		expect(tag("Admin")).not.toMatch(/\bml-auto\b/);
	});
});

describe("the breadcrumbs", () => {
	const crumbs = [
		{ label: "Repositories", href: "#/" },
		{ label: "acme/storefront", href: "#/repos/acme/storefront" },
		{ label: "Let shoppers apply a coupon code in the cart drawer." },
	];
	const items = (html: string) => [...html.matchAll(/<li class="([^"]*)"/g)].map((match) => match[1]!);

	it("lets only the last crumb shrink, so the others never print under it", () => {
		const [first, second, last] = items(renderToStaticMarkup(<TopBar crumbs={crumbs} />));
		expect(first).toMatch(/\bshrink-0\b/);
		expect(second).toMatch(/\bshrink-0\b/);
		expect(last).toMatch(/\bmin-w-0\b/);
		expect(last).not.toMatch(/\bshrink-0\b/);
	});

	it("keeps only the last crumb on a phone, and a lone crumb always", () => {
		const [first, second, last] = items(renderToStaticMarkup(<TopBar crumbs={crumbs} />));
		expect(first).toMatch(/\bto-560:hidden\b/);
		expect(second).toMatch(/\bto-560:hidden\b/);
		expect(last).not.toMatch(/\bto-560:hidden\b/);
		const [only] = items(renderToStaticMarkup(<TopBar crumbs={[{ label: "Inbox" }]} />));
		expect(only).not.toMatch(/\bto-560:hidden\b/);
	});
});
