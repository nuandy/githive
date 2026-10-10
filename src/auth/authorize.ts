import type { Context } from "hono";
import {
	AuthorizationError,
	CimdFetchError,
	type ConsentDescription,
	type OAuthHelpers,
} from "@cloudflare/workers-oauth-provider";
import type { AuthEnv } from "./routes";
import { type Agent, type User, randomSecret } from "./store";
import { identityStore } from "./principal";

// The page an MCP client sends a person to (OAuth's authorize endpoint): sign
// in to GitHive, then choose which of your agents the client acts as, or make
// one. The library keeps the request server-side and binds the form to this
// browser; everything the client chose about itself is escaped.

const escape = (value: string) => value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

const HIVE = `<svg width="28" height="28" viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="7" style="fill: var(--mark-tile)"/><path d="M10.2 6.5h11.6l5.8 9.5-5.8 9.5H10.2L4.4 16z" fill="none" stroke-width="2.6" stroke-linejoin="round" style="stroke: var(--mark-line)"/><path d="M4.4 16H12" stroke-width="2.6" stroke-linecap="round" style="stroke: var(--mark-line)"/><circle cx="16" cy="16" r="4" fill="#e59a0b"/></svg>`;

function page(title: string, body: string, script = "") {
	return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)} · GitHive</title>
<style>
/* The dashboard's look (web/src/styles.css): ink on cool paper, ruled rather than boxed, amber and red lamps for notes and warnings. */
@font-face { font-family: "Overpass"; src: url("/fonts/overpass.woff2") format("woff2"); font-weight: 100 900; font-display: swap; unicode-range: U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD; }
@font-face { font-family: "Overpass Mono"; src: url("/fonts/overpass-mono.woff2") format("woff2"); font-weight: 300 700; font-display: swap; unicode-range: U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD; }
@font-face { font-family: "Separator"; src: local("Helvetica Neue"), local("HelveticaNeue"), local("Segoe UI"), local("Arial"), local("Roboto"); unicode-range: U+00B7; }
:root { --bg: #f5f6f4; --surface: #fbfcfb; --surface-2: #eef0ee; --line: #d3d9d6; --line-strong: #b7c0bc; --fg: #1e2b33; --muted: #56636b; --link: #23506e; --ink-fill: #1e2b33; --on-ink: #f5f6f4; --amber: #e59a0b; --amber-soft: #fbf0d9; --bad: #c03a2b; --bad-soft: #f8e4e1; --mark-tile: #1e2b33; --mark-line: #f5f6f4; color-scheme: light dark; }
@media (prefers-color-scheme: dark) { :root { --bg: #121a1f; --surface: #172127; --surface-2: #1d282f; --line: #2c3a41; --line-strong: #3d4d55; --fg: #e4e9e7; --muted: #9aa8a6; --link: #8cc0e0; --ink-fill: #e4e9e7; --on-ink: #121a1f; --amber: #f2b13a; --amber-soft: #33270f; --bad: #e5604f; --bad-soft: #3a1d1a; --mark-tile: #f5f6f4; --mark-line: #1e2b33; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 15px/1.55 "Separator", "Overpass", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; padding: 56px 16px; }
main { max-width: 460px; margin: 0 auto; display: grid; gap: 16px; }
.brand { display: flex; align-items: center; gap: 10px; font-weight: 800; font-size: 17px; letter-spacing: -0.01em; padding-bottom: 14px; border-bottom: 2px solid var(--fg); }
h1 { font-size: 22px; line-height: 1.25; margin: 4px 0 0; font-weight: 800; letter-spacing: -0.01em; text-wrap: balance; }
p { margin: 0; }
a { color: var(--link); }
.muted { color: var(--muted); }
.warn { background: var(--bad-soft); border-left: 3px solid var(--bad); padding: 10px 12px; }
.note { background: var(--amber-soft); border-left: 3px solid var(--amber); padding: 10px 12px; }
fieldset { border: 0; border-top: 1px solid var(--line); padding: 12px 0 0; margin: 0; display: grid; gap: 10px; }
legend { padding: 0 8px 0 0; font-weight: 700; }
label { display: flex; align-items: center; gap: 8px; }
input[type=radio] { accent-color: var(--ink-fill); }
input[type=text] { font: inherit; padding: 6px 10px; border: 1px solid var(--line-strong); border-radius: 4px; background: var(--surface); color: var(--fg); min-width: 0; flex: 1; }
.actions { display: flex; gap: 10px; flex-wrap: wrap; padding-top: 4px; }
button, .button { font: inherit; font-weight: 600; padding: 8px 16px 7px; border-radius: 4px; border: 1px solid var(--line-strong); background: var(--surface); color: var(--fg); cursor: pointer; text-decoration: none; display: inline-block; }
button.primary, .button.primary { background: var(--ink-fill); border-color: var(--ink-fill); color: var(--on-ink); }
button:hover:not(:disabled), .button:hover { background: var(--surface-2); }
button.primary:hover:not(:disabled), .button.primary:hover { background: color-mix(in srgb, var(--ink-fill) 88%, var(--bg)); }
button:active:not(:disabled), .button:active { transform: translateY(1px); }
button:disabled { cursor: progress; opacity: 0.75; }
button[aria-busy="true"]::before { content: ""; display: inline-block; width: 0.8em; height: 0.8em; margin-right: 8px; vertical-align: -0.08em; border: 2px solid currentColor; border-right-color: transparent; border-radius: 50%; animation: spin 0.7s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { button[aria-busy="true"]::before { animation: none; } }
button:focus-visible, .button:focus-visible, input:focus-visible { outline: 2px solid var(--link); outline-offset: 2px; }
code { font-family: "Overpass Mono", ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.9em; }
</style></head>
<body><main><div class="brand">${HIVE} GitHive</div>${body}</main>${script}</body></html>`;
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

const html = (body: string, status = 200, headers?: Headers, redirectUri?: string, nonce?: string) => {
	const h = new Headers(headers);
	h.set("Content-Type", "text/html; charset=utf-8");
	h.set(
		"Content-Security-Policy",
		`default-src 'none'; style-src 'unsafe-inline'; font-src 'self'; img-src data:;${nonce ? ` script-src 'nonce-${nonce}';` : ""} form-action ${formAction(redirectUri)}; frame-ancestors 'none'`,
	);
	return new Response(body, { status, headers: h });
};

const problem = (message: string, status = 400) =>
	html(
		page(
			"Can't connect",
			`<h1>Can't connect this app</h1><p>${escape(message)}</p><p class="muted">Start connecting again from the app.</p>`,
		),
		status,
	);

function signInPage(details: ConsentDescription, returnTo: string, providers: string[]) {
	const names: Record<string, string> = { github: "GitHub", google: "Google" };
	const buttons = providers
		.map(
			(p) =>
				`<a class="button${p === "github" ? " primary" : ""}" href="/auth/${p}?return=${encodeURIComponent(returnTo)}">Sign in with ${names[p]}</a>`,
		)
		.join("");
	return page(
		"Sign in",
		`<h1>Sign in to connect ${escape(details.clientName)}</h1>
<p class="muted">${escape(details.clientName)} wants to work in GitHive as one of your agents. Sign in first.</p>
<div class="actions">${buttons || "<p>Sign-in isn't set up here.</p>"}</div>`,
	);
}

/**
 * Feedback once Allow or Deny is clicked: the button says what's happening,
 * and both are disabled so the choice is sent once. A disabled button isn't
 * submitted, so the choice goes in a hidden field first. Coming back to the
 * page (the browser's Back) makes them usable again.
 */
export const SUBMIT_FEEDBACK = `const form = document.querySelector("form");
form.addEventListener("submit", (event) => {
	const button = event.submitter;
	if (!button || !button.name) return;
	const choice = document.createElement("input");
	choice.type = "hidden";
	choice.name = button.name;
	choice.value = button.value;
	form.appendChild(choice);
	for (const b of form.querySelectorAll("button")) b.disabled = true;
	button.setAttribute("aria-busy", "true");
	button.textContent = button.value === "approve" ? "Connecting…" : "Cancelling…";
});
window.addEventListener("pageshow", (event) => {
	if (event.persisted) location.reload();
});`;

const feedbackScript = (nonce: string) => `<script nonce="${nonce}">${SUBMIT_FEEDBACK}</script>`;

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

function consentPage(
	details: ConsentDescription,
	handle: string,
	user: User,
	agents: Agent[],
	nonce: string,
	error?: string,
) {
	const name = escape(details.clientName);
	const suggested = suggestedAgentName(details.clientName);
	// The agent this app has acted as before, by its name; otherwise a new one named for the app.
	const match = agents.find((a) => a.name === suggested);
	const who = details.clientDomain
		? `${name}, published by <strong>${escape(details.clientDomain)}</strong>`
		: `${name}`;
	// The redirect's host is always shown, as the MCP spec requires.
	const where = details.redirectIsLoopback
		? `an app on this computer (<strong>${escape(details.redirectHost)}</strong>)`
		: `<strong>${escape(details.redirectHost)}</strong>`;
	const choices = agents
		.map(
			(a) =>
				`<label><input type="radio" name="agent" value="${escape(a.id)}"${a === match ? " checked" : ""}> <code>${escape(user.handle)}/${escape(a.name)}</code></label>`,
		)
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
		feedbackScript(nonce),
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
			const providers = (["github", "google"] as const).filter(
				(p) => (c.env as unknown as Record<string, unknown>)[`${p.toUpperCase()}_CLIENT_ID`],
			);
			return html(signInPage(details, `${url.pathname}${url.search}`, providers));
		}
		const user = principal.user;
		const active = async () => (await ids.agents(user.id)).filter((a) => !a.revokedAt);

		if (c.req.method === "GET") {
			const consent = await oauth.beginConsent(request);
			const nonce = randomSecret(16);
			return html(
				consentPage(details, consent.handle, user, await active(), nonce),
				200,
				consent.headers,
				details.redirectUri,
				nonce,
			);
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
			agent =
				choice === "new"
					? await ids.createAgent(user.id, String(form.get("new_name") ?? ""))
					: (await active()).find((a) => a.id === choice);
		} catch (err) {
			const nonce = randomSecret(16);
			return html(
				consentPage(
					details,
					handle,
					user,
					await active(),
					nonce,
					(err instanceof Error ? err.message : String(err)).replace(/^\[\d+\]\s*/, ""),
				),
				400,
				undefined,
				details.redirectUri,
				nonce,
			);
		}
		if (!agent) {
			const nonce = randomSecret(16);
			return html(
				consentPage(details, handle, user, await active(), nonce, "Choose one of your agents, or name a new one."),
				400,
				undefined,
				details.redirectUri,
				nonce,
			);
		}
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
		if (error instanceof AuthorizationError)
			return problem(error.description ?? "This request has expired or was already used.");
		if (error instanceof CimdFetchError) return problem("This app could not be verified.");
		throw error;
	}
}
