import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { visibleText } from "../test/fixtures";
import { TopBar } from "./TopBar";

// The top bar for someone signed out, reading a public repo.

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
