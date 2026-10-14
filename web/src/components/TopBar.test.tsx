import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { inlineText, visibleText } from "../test/fixtures";
import { TopBar } from "./TopBar";

// The top bar for someone signed out, reading a public repo, and for someone signed in.

/** A link's or button's markup, found by where it goes or by its slot. */
const linkTo = (html: string, href: string) =>
	html.match(new RegExp(`<a [^>]*href="${href}"[^>]*>[\\s\\S]*?</a>`))?.[0] ?? "";
const userButton = (html: string) =>
	[...html.matchAll(/<button [^>]*data-slot="dropdown-menu-trigger"[^>]*>[\s\S]*?<\/button>/g)]
		.map((match) => match[0])
		.find((button) => button.includes("Signed in as")) ?? "";
/** What a control is named by its words: its markup's text, but for what's hidden from a screen reader. */
const named = (markup: string) =>
	inlineText(markup.replace(/<span[^>]*aria-hidden="true"[^>]*>[^<]*<\/span>/g, "")).trim();

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
		const menuAt = html.indexOf(userButton(html));
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
		const tag = (href: string) => markup.match(new RegExp(`<a [^>]*href="${href}"[^>]*>`))?.[0] ?? "";
		expect(tag("#/inbox")).toMatch(/\bml-auto\b/);
		expect(tag("#/admin")).not.toBe("");
		expect(tag("#/admin")).not.toMatch(/\bml-auto\b/);
	});

	it("names the user menu by what it shows, the person's handle, after who's signed in", () => {
		const html = renderToStaticMarkup(<TopBar crumbs={[]} me={me} onSignOut={() => undefined} />);
		const button = userButton(html);
		expect(button).not.toContain("aria-label");
		expect(named(button)).toBe("Signed in as ada");
		// The initial is a picture of the name, not more of it; on a phone the handle is still its name, unseen.
		expect(button).toMatch(/<span[^>]*aria-hidden="true"[^>]*>A<\/span>/);
		expect(button).toMatch(/<span class="to-560:sr-only">ada<\/span>/);
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

describe("the Inbox", () => {
	const tag = (html: string) => html.match(/<a [^>]*href="#\/inbox"[^>]*>/)?.[0] ?? "";

	it("is named by what it shows, the count after its name, and what the count is", () => {
		const link = linkTo(renderToStaticMarkup(<TopBar crumbs={[]} inboxCount={5} />), "#/inbox");
		expect(link).not.toContain("aria-label");
		expect(named(link)).toBe("Inbox 5 waiting on you");
		expect(named(linkTo(renderToStaticMarkup(<TopBar crumbs={[]} inboxCount={0} />), "#/inbox"))).toBe("Inbox");
	});

	it("leads: filled in the color of what asks you while something waits, and named even on a phone", () => {
		const waiting = renderToStaticMarkup(<TopBar crumbs={[]} inboxCount={2} />);
		expect(tag(waiting)).toMatch(/\bbg-needs-soft\b/);
		expect(tag(waiting)).toMatch(/\btext-needs\b/);
		expect(waiting).toMatch(/<span>Inbox<\/span>/);
		expect(tag(renderToStaticMarkup(<TopBar crumbs={[]} inboxCount={0} />))).not.toMatch(/\bbg-needs-soft\b/);
	});

	it("counts an operator's Admin requests in a neutral counter, so the Inbox's is the one red number", () => {
		const access = { kind: "access" as const, label: "admin", by: "access:admin" };
		const html = renderToStaticMarkup(<TopBar crumbs={[]} me={access} inboxCount={1} adminRequests={3} />);
		const admin = linkTo(html, "#/admin");
		expect(admin).not.toContain("aria-label");
		expect(named(admin)).toBe("Admin 3 requests waiting");
		expect(admin.match(/<span[^>]*>3<\/span>/)?.[0]).toMatch(/\bbg-surface-3\b/);
		expect(admin.match(/<span[^>]*>3<\/span>/)?.[0]).not.toMatch(/\bbg-needs\b/);
	});

	it("moves light and dark into a person's menu on a phone, keeping it in the bar for anyone else", () => {
		const me = { kind: "user" as const, handle: "ada", name: "Ada", email: "a@x", avatarUrl: null, by: "person:ada" };
		const theme = (html: string) => html.match(/<button[^>]*aria-label="Theme:[^"]*"[^>]*>/)?.[0] ?? "";
		expect(theme(renderToStaticMarkup(<TopBar crumbs={[]} me={me} />))).toMatch(/\bto-560:hidden\b/);
		expect(theme(renderToStaticMarkup(<TopBar crumbs={[]} onSignIn={() => undefined} />))).not.toMatch(
			/\bto-560:hidden\b/,
		);
	});
});

describe("the way to repositories", () => {
	const crumbs = [
		{ label: "acme", href: "#/orgs/acme" },
		{ label: "storefront", href: "#/repos/acme/storefront", repo: "acme/storefront" },
	];

	it("links the repo's owner, and makes its name a switcher of the reader's repos", () => {
		const html = renderToStaticMarkup(<TopBar crumbs={crumbs} repos={["acme/storefront", "acme/docs"]} />);
		expect(html).toMatch(/<a class="text-foreground" href="#\/orgs\/acme">acme<\/a>/);
		expect(html).toMatch(/<button[^>]*aria-label="acme\/storefront: switch repository"/);
		expect(visibleText(html)).toContain("storefront");
	});

	it("keeps a plain name for someone signed out, who has no repos to switch to", () => {
		const html = renderToStaticMarkup(<TopBar crumbs={crumbs} onSignIn={() => undefined} />);
		expect(html).not.toContain("switch repository");
		expect(html).not.toContain(">Repositories<");
	});

	it("puts Repositories beside the mark on a wide screen, current on Repositories itself", () => {
		const html = renderToStaticMarkup(<TopBar crumbs={[]} repos={[]} onRepos />);
		const item = html.match(/<li class="[^"]*"><a [^>]*href="#\/"[^>]*>Repositories<\/a>/)?.[0] ?? "";
		expect(item).toMatch(/\bto-720:hidden\b/);
		expect(item).toContain('aria-current="page"');
	});
});
