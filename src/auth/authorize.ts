import type { Context } from "hono";
import { AuthorizationError, CimdFetchError, type ConsentDescription, type OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import type { AuthEnv } from "./routes";
import type { Agent, User } from "./store";
import { identityStore } from "./principal";

// The page an MCP client sends a person to (OAuth's authorize endpoint): sign
// in to GitHive, then choose which of your agents the client acts as, or make
// one. The library keeps the request server-side and binds the form to this
// browser; everything the client chose about itself is escaped.

const escape = (value: string) => value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

const HIVE = `<svg width="28" height="28" viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="7" fill="#f2a516"/><g fill="#fff" stroke="#f2a516" stroke-width="1.2"><rect x="12" y="5.5" width="8" height="5" rx="2.5"/><rect x="9" y="10" width="14" height="5" rx="2.5"/><rect x="7" y="14.5" width="18" height="5" rx="2.5"/><rect x="6" y="19" width="20" height="5.5" rx="2.75"/></g><rect x="4.5" y="24.2" width="23" height="2.6" rx="1.3" fill="#fff"/><path d="M13.6 24.4a2.4 2.4 0 0 1 4.8 0z" fill="#7a4a06"/></svg>`;

function page(title: string, body: string) {
	return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)} · GitHive</title>
<style>
:root { --bg: #f6f7f9; --surface: #fff; --line: #dfe3e8; --fg: #1b1f24; --muted: #5b6573; --honey: #f2a516; --honey-ink: #9a5b00; --honey-soft: #fdf1d9; --on-honey: #2b1c00; --warn: #c2410c; --warn-soft: #fef3ec; color-scheme: light dark; }
@media (prefers-color-scheme: dark) { :root { --bg: #0f1216; --surface: #171b21; --line: #2b323c; --fg: #e6e9ee; --muted: #98a2b3; --honey-ink: #f6b840; --honey-soft: #33270f; --on-honey: #1f1400; --warn: #f2894f; --warn-soft: #36211a; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 15px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; padding: 48px 16px; }
main { max-width: 460px; margin: 0 auto; background: var(--surface); border: 1px solid var(--line); border-radius: 12px; padding: 28px; display: grid; gap: 16px; }
.brand { display: flex; align-items: center; gap: 10px; font-weight: 700; }
h1 { font-size: 20px; line-height: 1.3; margin: 0; }
p { margin: 0; }
.muted { color: var(--muted); }
.warn { background: var(--warn-soft); color: var(--warn); border-radius: 8px; padding: 10px 12px; }
.note { background: var(--honey-soft); border-radius: 8px; padding: 10px 12px; }
fieldset { border: 1px solid var(--line); border-radius: 8px; padding: 10px 14px 12px; margin: 0; display: grid; gap: 8px; }
legend { padding: 0 4px; font-weight: 600; }
label { display: flex; align-items: center; gap: 8px; }
input[type=text] { font: inherit; padding: 6px 8px; border: 1px solid var(--line); border-radius: 6px; background: var(--bg); color: var(--fg); min-width: 0; flex: 1; }
.actions { display: flex; gap: 10px; flex-wrap: wrap; }
button, .button { font: inherit; font-weight: 600; padding: 8px 16px; border-radius: 8px; border: 1px solid var(--line); background: var(--surface); color: var(--fg); cursor: pointer; text-decoration: none; display: inline-block; }
button.primary, .button.primary { background: var(--honey); border-color: var(--honey); color: var(--on-honey); }
button:focus-visible, .button:focus-visible, input:focus-visible { outline: 2px solid var(--honey-ink); outline-offset: 2px; }
code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.9em; }
</style></head>
<body><main><div class="brand">${HIVE} GitHive</div>${body}</main></body></html>`;
}

/**
 * Where a form on the page may lead: GitHive, and the one app this request
 * goes back to. Browsers apply form-action to the redirect after a submit, so
 * without the app's origin, Allow's redirect back to it is silently blocked.
 */
export function formAction(redirectUri?: string) {
	if (!redirectUri) return "'self'";
	try {
		const url = new URL(redirectUri);
		const target = url.protocol === "http:" || url.protocol === "https:" ? url.origin : url.protocol;
		return /^[A-Za-z0-9+.:/\[\]-]+$/.test(target) ? `'self' ${target}` : "'self'";
	} catch {
		return "'self'";
	}
}

const html = (body: string, status = 200, headers?: Headers, redirectUri?: string) => {
	const h = new Headers(headers);
	h.set("Content-Type", "text/html; charset=utf-8");
	h.set("Content-Security-Policy", `default-src 'none'; style-src 'unsafe-inline'; img-src data:; form-action ${formAction(redirectUri)}; frame-ancestors 'none'`);
	return new Response(body, { status, headers: h });
};

const problem = (message: string, status = 400) => html(page("Can't connect", `<h1>Can't connect this app</h1><p>${escape(message)}</p><p class="muted">Start connecting again from the app.</p>`), status);

function signInPage(details: ConsentDescription, returnTo: string, providers: string[]) {
	const names: Record<string, string> = { github: "GitHub", google: "Google" };
	const buttons = providers.map((p) => `<a class="button${p === "github" ? " primary" : ""}" href="/auth/${p}?return=${encodeURIComponent(returnTo)}">Sign in with ${names[p]}</a>`).join("");
	return page(
		"Sign in",
		`<h1>Sign in to connect ${escape(details.clientName)}</h1>
<p class="muted">${escape(details.clientName)} wants to work in GitHive as one of your agents. Sign in first.</p>
<div class="actions">${buttons || "<p>Sign-in isn't set up here.</p>"}</div>`,
	);
}

/** A name for a new agent from the app's own name: "Claude Code (githive)" is claude-code. */
export function suggestedAgentName(clientName: string) {
	return clientName
		.replace(/\([^)]*\)/g, " ")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 32)
		.replace(/-+$/, "");
}

function consentPage(details: ConsentDescription, handle: string, user: User, agents: Agent[], error?: string) {
	const name = escape(details.clientName);
	const suggested = suggestedAgentName(details.clientName);
	// The agent this app has acted as before, by its name; otherwise a new one named for the app.
	const match = agents.find((a) => a.name === suggested);
	const who = details.clientDomain ? `${name}, published by <strong>${escape(details.clientDomain)}</strong>` : `${name}`;
	// The redirect's host is always shown, as the MCP spec requires.
	const where = details.redirectIsLoopback ? `an app on this computer (<strong>${escape(details.redirectHost)}</strong>)` : `<strong>${escape(details.redirectHost)}</strong>`;
	const choices = agents
		.map((a) => `<label><input type="radio" name="agent" value="${escape(a.id)}"${a === match ? " checked" : ""}> <code>${escape(user.handle)}/${escape(a.name)}</code></label>`)
		.join("");
	return page(
		`Connect ${details.clientName}`,
		`<h1>Connect ${name} to GitHive</h1>
<p>${who} will work in GitHive as one of your agents: it can claim paths, push, review, vote and merge, and what it does is attributed to that agent.</p>
<p class="muted">${details.clientDomain ? "" : "The app gave itself this name; GitHive can't confirm it. "}Access goes to ${where}.</p>
${details.redirectIsLoopback ? '<p class="note">Claude Code, Codex and similar apps run on your computer, so this is expected if you just started connecting from one. If you didn\'t, choose Deny.</p>' : ""}
${error ? `<p class="warn" role="alert">${escape(error)}</p>` : ""}
<form method="post">
<input type="hidden" name="handle" value="${escape(handle)}">
<fieldset><legend>Act as</legend>
${choices}
<label><input type="radio" name="agent" value="new"${match ? "" : " checked"}> a new agent <code>${escape(user.handle)}/</code><input type="text" name="new_name" aria-label="New agent's name" value="${match ? "" : escape(suggested)}" pattern="[a-z0-9][a-z0-9\\-]{0,31}" autocomplete="off" spellcheck="false"></label>
</fieldset>
<p class="muted">You can revoke it any time on your Agents page.</p>
<div class="actions"><button class="primary" name="decision" value="approve">Allow</button><button name="decision" value="deny">Deny</button></div>
</form>`,
	);
}

const oauthOf = (env: Env) => (env as unknown as { OAUTH_PROVIDER?: OAuthHelpers }).OAUTH_PROVIDER;

/** GET and POST /authorize. */
export async function authorize(c: Context<AuthEnv>) {
	const oauth = oauthOf(c.env);
	const ids = identityStore(c.env);
	if (!oauth || !ids) return problem("Connecting apps isn't set up on this address.", 404);
	try {
		const request = await oauth.parseAuthRequest(c.req.raw);
		const details = await oauth.describeConsent(request);
		const principal = c.get("principal");
		if (principal?.kind !== "user") {
			const url = new URL(c.req.url);
			const providers = (["github", "google"] as const).filter((p) => (c.env as unknown as Record<string, unknown>)[`${p.toUpperCase()}_CLIENT_ID`]);
			return html(signInPage(details, `${url.pathname}${url.search}`, providers));
		}
		const user = principal.user;
		const active = async () => (await ids.agents(user.id)).filter((a) => !a.revokedAt);

		if (c.req.method === "GET") {
			const consent = await oauth.beginConsent(request);
			return html(consentPage(details, consent.handle, user, await active()), 200, consent.headers, details.redirectUri);
		}

		const form = await c.req.formData();
		const handle = String(form.get("handle") ?? "");
		if (form.get("decision") !== "approve") {
			const denied = await oauth.denyConsent(c.req.raw, handle);
			return new Response(null, { status: 302, headers: denied.headers });
		}
		// The agent first: a bad name shows the form again, with the handle still unused.
		const choice = String(form.get("agent") ?? "");
		let agent: Agent | undefined;
		try {
			agent = choice === "new" ? await ids.createAgent(user.id, String(form.get("new_name") ?? "")) : (await active()).find((a) => a.id === choice);
		} catch (err) {
			return html(consentPage(details, handle, user, await active(), (err instanceof Error ? err.message : String(err)).replace(/^\[\d+\]\s*/, "")), 400, undefined, details.redirectUri);
		}
		if (!agent) return html(consentPage(details, handle, user, await active(), "Choose one of your agents, or name a new one."), 400, undefined, details.redirectUri);
		const approved = await oauth.approveConsent(c.req.raw, handle, { scope: request.scope });
		const { redirectTo } = await oauth.completeAuthorization({
			request: approved.request,
			userId: user.id,
			metadata: { agentId: agent.id, agent: `${user.handle}/${agent.name}` },
			scope: approved.request.scope,
			props: { userId: user.id, agentId: agent.id },
		});
		approved.headers.set("Location", redirectTo);
		return new Response(null, { status: 302, headers: approved.headers });
	} catch (error) {
		if (error instanceof AuthorizationError && error.redirectTo) return Response.redirect(error.redirectTo, 302);
		if (error instanceof AuthorizationError) return problem(error.description ?? "This request has expired or was already used.");
		if (error instanceof CimdFetchError) return problem("This app could not be verified.");
		throw error;
	}
}
