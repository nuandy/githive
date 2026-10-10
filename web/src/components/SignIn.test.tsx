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

	it("says so when no sign-in is set up on this address", () => {
		const html = renderToStaticMarkup(<SignIn providers={[]} />);
		expect(visibleText(html)).toContain("set up on this address.");
		expect(html).not.toContain("/auth/");
	});
});

describe("the sign-in screen with an invite code", () => {
	it("asks for the code only where one lets people in, and fills in the one the link carried", () => {
		expect(visibleText(renderToStaticMarkup(<SignIn providers={["github"]} />))).not.toContain("Invite code");
		const html = renderToStaticMarkup(<SignIn providers={["github"]} takesInviteCode invite="hive-2026" />);
		expect(visibleText(html)).toContain("Invite code, if you have one");
		expect(html).toContain('value="hive-2026"');
		expect(html).toContain(`href="/auth/github?return=${encodeURIComponent("/")}&amp;invite=hive-2026"`);
	});
});
