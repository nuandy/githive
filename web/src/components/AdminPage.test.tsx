import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { NOW, ago, inlineText, visibleText } from "../test/fixtures";
import { type AdminActions, AdminView } from "./AdminPage";
import { TopBar } from "./TopBar";

// The Admin page, for GitHive's operators through Access: orgs' requests to
// approve or turn down, who may sign in, and who may start hosted agents.

const noop = async () => ({}) as never;
const actions: AdminActions = {
	approve: noop,
	removeInvite: noop,
	decline: noop,
	allowHosted: noop,
	disallowHosted: noop,
};

describe("the Admin page", () => {
	it("lists who tried to sign in uninvited, with how and how often", () => {
		const signIn = { provider: "github", name: "Eve", login: "eve", tries: 3, lastAt: ago(5) };
		const requests = [{ email: "eve@example.com", orgs: [], createdAt: ago(90), signIn }];
		const html = renderToStaticMarkup(
			<AdminView requests={requests} invites={[]} hosted={[]} actions={actions} now={NOW} />,
		);
		const text = visibleText(html);
		expect(text).toContain("eve@example.com");
		expect(text).toContain("tried to sign in with GitHub as eve, 3 times");
		expect(text).toContain("Approve");
	});

	it("lists orgs' requests with who asked, the approved emails, and who may start hosted agents", () => {
		const html = renderToStaticMarkup(
			<AdminView
				requests={[
					{ email: "dan@example.com", orgs: [{ org: "acme", role: "admin", invitedBy: "ada" }], createdAt: ago(30) },
				]}
				invites={[{ email: "ada@example.com", invitedBy: "admin@example.com", createdAt: ago(60 * 24) }]}
				hosted={[{ handle: "ada", grantedBy: "admin@example.com", createdAt: ago(60) }]}
				actions={actions}
				now={NOW}
			/>,
		);
		const text = visibleText(html);
		expect(text).toContain("dan@example.com");
		expect(text).toContain("@acme as admin, asked by ada");
		expect(text).toContain("Approve");
		expect(text).toContain("Turn down");
		expect(text).toContain("ada@example.com");
		expect(text).toMatch(/doesn.t sign out someone already signed in/);
		expect(text).toContain("allowed by admin@example.com");
		expect(text).toMatch(/run on GitHive.s model account, so only the people listed here can start them/);
		// The forms that add to a list are labelled, and come after it.
		expect(html).toMatch(/<label[^>]*for="admin-email">Email to approve<\/label>/);
		expect(html).toMatch(/<label[^>]*for="admin-hosted-handle">Their handle<\/label>/);
		expect(html).not.toContain("placeholder=");
		expect(html.indexOf("ada@example.com")).toBeLessThan(html.indexOf('for="admin-email"'));
		expect(html.indexOf("allowed by admin@example.com")).toBeLessThan(html.indexOf('for="admin-hosted-handle"'));
	});

	it("says when there's nothing waiting, and nobody listed", () => {
		const text = visibleText(
			renderToStaticMarkup(<AdminView requests={[]} invites={[]} hosted={[]} actions={actions} now={NOW} />),
		);
		expect(text).toContain("No requests waiting.");
		expect(text).toContain("Nobody is approved yet.");
		expect(text).toContain("Nobody may start hosted agents yet.");
	});

	it("is reached from the top bar by Access callers, with the requests waiting counted", () => {
		const html = renderToStaticMarkup(
			<TopBar crumbs={[]} me={{ kind: "access", label: "admin@example.com", by: "person:x" }} adminRequests={2} />,
		);
		expect(html).toContain('href="#/admin"');
		expect(inlineText(html)).toContain("Admin 2 requests waiting");
		const person = renderToStaticMarkup(
			<TopBar
				crumbs={[]}
				me={{ kind: "user", handle: "ada", name: null, email: "ada@example.com", avatarUrl: null, by: "person:x" }}
				onSignOut={() => undefined}
			/>,
		);
		expect(person).not.toContain('href="#/admin"');
	});
});
