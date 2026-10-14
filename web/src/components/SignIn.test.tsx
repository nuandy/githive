import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { visibleText } from "../test/fixtures";
import { SignIn } from "./SignIn";

describe("the sign-in screen", () => {
	it("offers each provider set up here, returning to the page the person was on", () => {
		const html = renderToStaticMarkup(<SignIn providers={["github", "google"]} hash="#/repos/docs" />);
		expect(visibleText(html)).toContain("Sign in to GitHive");
		expect(html).toContain(`href="/auth/github?return=${encodeURIComponent("/#/repos/docs")}"`);
		expect(html).toContain(`href="/auth/google?return=${encodeURIComponent("/#/repos/docs")}"`);
		expect(visibleText(html)).toContain("Continue with GitHub");
		expect(visibleText(html)).toContain("Continue with Google");
	});

	it("links to the demo repo's hive, to watch agents at work signed out, when there is one", () => {
		const html = renderToStaticMarkup(<SignIn providers={["github"]} demoRepo="nuandy/honeycomb" />);
		expect(html).toContain('href="#/repos/nuandy/honeycomb"');
		expect(visibleText(html)).toContain("See a hive at work →");
		expect(visibleText(renderToStaticMarkup(<SignIn providers={["github"]} />))).not.toContain("See a hive at work");
	});

	it("says why the last sign-in failed", () => {
		const html = renderToStaticMarkup(
			<SignIn
				providers={["github"]}
				error="This email isn't invited to GitHive yet. Ask an admin for an invitation."
			/>,
		);
		expect(html).toContain('role="alert"');
		expect(visibleText(html)).toContain("invited to GitHive yet. Ask an admin for an invitation.");
	});

	it("ends with where to read more: the source, how it works, how to get an invite and what happens to your data", () => {
		const html = renderToStaticMarkup(<SignIn providers={["github"]} />);
		const footer = html.slice(html.indexOf("<footer"));
		for (const label of ["Source on GitHub", "How it works", "Ask for an invite", "Your data", "MIT license"])
			expect(visibleText(footer)).toContain(label);
		expect(footer).toContain('href="https://github.com/nuandy/githive#try-it"');
		expect(footer).toContain('href="https://github.com/nuandy/githive/blob/main/docs/operating.md#data-and-security"');
	});

	it("says so when no sign-in is set up on this address", () => {
		const html = renderToStaticMarkup(<SignIn providers={[]} />);
		expect(visibleText(html)).toContain("set up on this address.");
		expect(html).not.toContain("/auth/");
	});
});

describe("the sign-in screen with an invite code", () => {
	it("asks for the code only where one lets people in, and fills in the one the link carried", () => {
		const withoutCode = visibleText(renderToStaticMarkup(<SignIn providers={["github"]} />));
		expect(withoutCode).not.toContain("Invite code");
		expect(withoutCode).toContain("signing in asks an admin to let you in");
		const html = renderToStaticMarkup(<SignIn providers={["github"]} takesInviteCode invite="hive-2026" />);
		expect(visibleText(html)).toContain("Invite code, if you have one");
		expect(html).toContain('value="hive-2026"');
		expect(html).toContain(`href="/auth/github?return=${encodeURIComponent("/")}&amp;invite=hive-2026"`);
	});

	it("says, above the buttons, that going on without a code asks an admin", () => {
		const html = renderToStaticMarkup(<SignIn providers={["github"]} takesInviteCode />);
		const text = visibleText(html);
		const said = text.indexOf("No code? Continue anyway and we");
		expect(said).toBeGreaterThan(0);
		expect(text).toContain("ll ask an admin to let you in.");
		expect(said).toBeLessThan(text.indexOf("Continue with GitHub"));
	});
});

describe("the sign-in screen's other ways in", () => {
	it("says when a session has ended", () => {
		const html = renderToStaticMarkup(
			<SignIn providers={["github"]} notice="Your session ended. Sign in again to continue." />,
		);
		expect(html).toContain('role="status"');
		expect(visibleText(html)).toContain("Your session ended. Sign in again to continue.");
	});

	it("after a request to join, says the account it's noted under, how they'll hear, and offers the demo", () => {
		const html = renderToStaticMarkup(
			<SignIn providers={["github"]} request={{ account: "eve@example.com" }} demoRepo="nuandy/honeycomb" />,
		);
		const text = visibleText(html);
		expect(html).toMatch(/<h1[^>]*>Your request to join is noted<\/h1>/);
		expect(text).toContain("eve@example.com");
		expect(text).toContain("An admin lets people in by hand.");
		expect(text).toContain("sign in again later");
		expect(html).toMatch(/<a [^>]*href="#\/repos\/nuandy\/honeycomb"[^>]*>Watch a hive build a game<\/a>/);
		// Signing in again, perhaps as another account, is still there.
		expect(text).toContain("Continue with GitHub");
		// Without the account (an older server), it still says the request is noted.
		expect(visibleText(renderToStaticMarkup(<SignIn providers={["github"]} request={{ account: null }} />))).toContain(
			"Your request to join is noted",
		);
	});
});
