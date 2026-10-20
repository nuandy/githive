import type { Context } from "hono";
import {
	AuthorizationError,
	CimdFetchError,
	type ConsentDescription,
	type OAuthHelpers,
} from "@cloudflare/workers-oauth-provider";
import type { AuthEnv } from "./routes";
import { type Agent, type User, randomSecret } from "./store";
import { PAGE_STYLE } from "./page-style";
import { identityStore } from "./principal";

// OAuth's authorize page for MCP clients. A person signs in to GitHive and picks, or creates, the agent the
// client acts as. The library keeps the request server-side and binds the form to this browser. Everything the
// client says about itself is escaped.

export const escape = (value: string) => value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

const HIVE =
	`<svg width="28" height="28" viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="7" ` +
	`style="fill: var(--mark-tile)"/><path d="M10.2 6.5h11.6l5.8 9.5-5.8 9.5H10.2L4.4 16z" fill="none" ` +
	`stroke-width="2.6" stroke-linejoin="round" style="stroke: var(--mark-line)"/><path d="M4.4 16H12" ` +
	`stroke-width="2.6" stroke-linecap="round" style="stroke: var(--mark-line)"/><circle cx="16" cy="16" r="4" ` +
	`fill="#e59a0b"/></svg>`;

export function page(title: string, body: string, script = "") {
	return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)} · GitHive</title>
<style>${PAGE_STYLE}</style></head>
<body><main><div class="brand">${HIVE} GitHive</div>${body}</main>${script}</body></html>`;
}

/**
 * The form-action sources: GitHive and the app this request returns to. Browsers apply form-action to the
 * redirect after a submit, so without the app's origin the redirect back is silently blocked.
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

export const html = (body: string, status = 200, headers?: Headers, redirectUri?: string, nonce?: string) => {
	const responseHeaders = new Headers(headers);
	responseHeaders.set("Content-Type", "text/html; charset=utf-8");
	const scriptSource = nonce ? ` script-src 'nonce-${nonce}';` : "";
	responseHeaders.set(
		"Content-Security-Policy",
		`default-src 'none'; style-src 'unsafe-inline'; font-src 'self'; img-src data:;${scriptSource} ` +
			`form-action ${formAction(redirectUri)}; frame-ancestors 'none'`,
	);
	return new Response(body, { status, headers: responseHeaders });
};

const problem = (message: string, status = 400) =>
	html(
		page(
			"Can't connect",
			`<h1>Can't connect this app</h1><p>${escape(message)}</p><p class="muted">Start connecting ` +
				"again from the app.</p>",
		),
		status,
	);

function signInPage(details: ConsentDescription, returnTo: string, providers: string[]) {
	const names: Record<string, string> = { github: "GitHub", google: "Google" };
	const button = (provider: string) => {
		const kind = provider === "github" ? "button primary" : "button";
		const href = `/auth/${provider}?return=${encodeURIComponent(returnTo)}`;
		return `<a class="${kind}" href="${href}">Sign in with ${names[provider]}</a>`;
	};
	const buttons = providers.map(button).join("");
	return page(
		"Sign in",
		`<h1>Sign in to connect ${escape(details.clientName)}</h1>
<p class="muted">${escape(details.clientName)} wants to work in GitHive as one of your agents. Sign in first.</p>
<div class="actions">${buttons || "<p>Sign-in isn't set up here.</p>"}</div>`,
	);
}

/**
 * Disables both buttons after a click so the choice is sent once. A disabled button isn't submitted, so the
 * choice is copied to a hidden field first. Returning with the browser's Back button reloads the page.
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

/** A new agent's name derived from the app's name, so "Claude Code (githive)" becomes claude-code. */
export function suggestedAgentName(clientName: string) {
	return clientName
		.replace(/\([^)]*\)/g, " ")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 32)
		.replace(/-+$/, "");
}

const WHAT_AN_AGENT_DOES =
	"it can claim paths, push, review, vote and merge, and what it does is attributed to that agent.";

const DECISION_BUTTONS =
	'<div class="actions"><button class="primary" name="decision" value="approve">Allow</button>' +
	'<button name="decision" value="deny">Deny</button></div>';

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
	// Preselect the agent named for this app, if there is one. Otherwise suggest a new one.
	const match = agents.find((agent) => agent.name === suggested);
	const who = details.clientDomain
		? `${name}, published by <strong>${escape(details.clientDomain)}</strong>`
		: `${name}`;
	// The redirect's host is always shown, as the MCP spec requires.
	const where = details.redirectIsLoopback
		? `an app on this computer (<strong>${escape(details.redirectHost)}</strong>)`
		: `<strong>${escape(details.redirectHost)}</strong>`;
	const choices = agents
		.map(
			(agent) =>
				`<label><input type="radio" name="agent" value="${escape(agent.id)}"${agent === match ? " checked" : ""}> ` +
				`<code>${escape(user.handle)}/${escape(agent.name)}</code></label>`,
		)
		.join("");
	const unconfirmed = details.clientDomain ? "" : "The app gave itself this name; GitHive can't confirm it. ";
	const newAgent =
		`<label><input type="radio" name="agent" value="new"${match ? "" : " checked"}> a new agent ` +
		`<code>${escape(user.handle)}/</code><input type="text" name="new_name" aria-label="New agent's name" ` +
		`value="${match ? "" : escape(suggested)}" pattern="[a-z0-9][a-z0-9\\-]{0,31}" autocomplete="off" ` +
		`spellcheck="false"></label>`;
	return page(
		`Connect ${details.clientName}`,
		`<h1>Connect ${name} to GitHive</h1>
<p>${who} will work in GitHive as one of your agents: ${WHAT_AN_AGENT_DOES}</p>
<p class="muted">${unconfirmed}Access goes to ${where}.</p>
${
	details.redirectIsLoopback
		? '<p class="note">Claude Code, Codex and similar apps run on your computer, so this is expected if you just ' +
			"started connecting from one. If you didn't, choose Deny.</p>"
		: ""
}
${error ? `<p class="warn" role="alert">${escape(error)}</p>` : ""}
<form method="post">
<input type="hidden" name="handle" value="${escape(handle)}">
<fieldset><legend>Act as</legend>
${choices}
${newAgent}
</fieldset>
<p class="muted">You can revoke it any time on your Agents page.</p>
${DECISION_BUTTONS}
</form>`,
		feedbackScript(nonce),
	);
}

const oauthOf = (env: Env) => (env as unknown as { OAUTH_PROVIDER?: OAuthHelpers }).OAUTH_PROVIDER;

/** An error's message without its [status] prefix, to show on the form. */
function formError(err: unknown) {
	const message = err instanceof Error ? err.message : String(err);
	return message.replace(/^\[\d+\]\s*/, "");
}

function signInResponse(c: Context<AuthEnv>, details: ConsentDescription) {
	const url = new URL(c.req.url);
	const providers = (["github", "google"] as const).filter(
		(provider) => (c.env as unknown as Record<string, unknown>)[`${provider.toUpperCase()}_CLIENT_ID`],
	);
	return html(signInPage(details, `${url.pathname}${url.search}`, providers));
}

/** The consent form, with a fresh nonce for its script. */
function consentResponse(
	details: ConsentDescription,
	handle: string,
	user: User,
	agents: Agent[],
	options: { status?: number; headers?: Headers; error?: string } = {},
) {
	const nonce = randomSecret(16);
	const body = consentPage(details, handle, user, agents, nonce, options.error);
	return html(body, options.status ?? 200, options.headers, details.redirectUri, nonce);
}

export async function authorize(c: Context<AuthEnv>) {
	const oauth = oauthOf(c.env);
	const store = identityStore(c.env);
	if (!oauth || !store) return problem("Connecting apps isn't set up on this address.", 404);
	try {
		const request = await oauth.parseAuthRequest(c.req.raw);
		const details = await oauth.describeConsent(request);
		const principal = c.get("principal");
		if (principal?.kind !== "user") return signInResponse(c, details);
		const user = principal.user;
		const activeAgents = async () => (await store.agents(user.id)).filter((agent) => !agent.revokedAt);

		if (c.req.method === "GET") {
			const consent = await oauth.beginConsent(request);
			return consentResponse(details, consent.handle, user, await activeAgents(), { headers: consent.headers });
		}

		const form = await c.req.formData();
		const handle = String(form.get("handle") ?? "");
		if (form.get("decision") !== "approve") {
			const denied = await oauth.denyConsent(c.req.raw, handle);
			return new Response(null, { status: 302, headers: denied.headers });
		}
		// Resolve the agent first, so a bad name shows the form again while the consent handle is still unused.
		const choice = String(form.get("agent") ?? "");
		let agent: Agent | undefined;
		try {
			agent =
				choice === "new"
					? await store.createAgent(user.id, String(form.get("new_name") ?? ""))
					: (await activeAgents()).find((active) => active.id === choice);
		} catch (err) {
			return consentResponse(details, handle, user, await activeAgents(), { status: 400, error: formError(err) });
		}
		if (!agent) {
			const error = "Choose one of your agents, or name a new one.";
			return consentResponse(details, handle, user, await activeAgents(), { status: 400, error });
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
