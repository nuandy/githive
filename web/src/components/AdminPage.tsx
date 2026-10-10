import { type FormEvent, useState } from "react";
import type { AdminApi, ApprovedEmail, HostedUser, InviteRequest } from "../api";
import { usePoll } from "../hooks/usePoll";
import { timeAgo } from "../lib/relativeTime";
import { ConfirmButton, messageOf } from "./Confirm";
import "./Manage.css";

export type AdminActions = Pick<AdminApi, "approve" | "removeInvite" | "decline" | "allowHosted" | "disallowHosted">;

export interface AdminViewProps {
	/** Orgs' requests waiting for approval; undefined while loading. */
	requests: InviteRequest[] | undefined;
	/** Emails approved to sign in; undefined while loading. */
	invites: ApprovedEmail[] | undefined;
	/** Who may start GitHive's hosted agents; undefined while loading. */
	hosted: HostedUser[] | undefined;
	error?: string | null;
	actions: AdminActions;
	now?: number;
}

/**
 * GitHive's operators, through Cloudflare Access: orgs' requests to bring
 * someone in, who may sign in, and who may start GitHive's hosted agents.
 */
export function AdminView({ requests, invites, hosted, error, actions, now = Date.now() }: AdminViewProps) {
	const [busy, setBusy] = useState<string | null>(null);
	const [confirming, setConfirming] = useState<string | null>(null);
	const [rowError, setRowError] = useState<{ key: string; text: string } | null>(null);
	const [email, setEmail] = useState("");
	const [emailError, setEmailError] = useState<string | null>(null);
	const [handle, setHandle] = useState("");
	const [handleError, setHandleError] = useState<string | null>(null);

	const run = async (key: string, work: () => Promise<unknown>, onError: (text: string) => void) => {
		setBusy(key);
		setRowError(null);
		try {
			await work();
			setConfirming(null);
			return true;
		} catch (err) {
			onError(messageOf(err));
			return false;
		} finally {
			setBusy(null);
		}
	};
	const rowFailed = (key: string) => (text: string) => setRowError({ key, text });
	const errorFor = (key: string) =>
		rowError?.key === key ? (
			<p className="error manage__note" role="alert">
				{rowError.text}
			</p>
		) : null;

	const approveEmail = async (event: FormEvent) => {
		event.preventDefault();
		if (!email.trim()) return;
		setEmailError(null);
		if (await run("approve-email", () => actions.approve(email.trim()), setEmailError)) setEmail("");
	};
	const allowPerson = async (event: FormEvent) => {
		event.preventDefault();
		if (!handle.trim()) return;
		setHandleError(null);
		if (await run("allow-hosted", () => actions.allowHosted(handle.trim()), setHandleError)) setHandle("");
	};

	return (
		<main className="page manage" id="main">
			<header className="manage__header">
				<div>
					<h1>Admin</h1>
					<p className="muted manage__lede">
						Who may sign in to GitHive, and who may start its hosted agents. Only through Cloudflare Access.
					</p>
				</div>
			</header>
			{error ? (
				<div className="callout callout--bad" role="alert">
					{error}
				</div>
			) : null}

			<section className="box" aria-labelledby="admin-requests">
				<div className="box__header">
					<h2 id="admin-requests">Requests</h2>
				</div>
				<div className="box__body">
					<p className="manage__hint">
						People an organization invited who can't sign in until you approve them. Approved, they join those
						organizations when they first sign in.
					</p>
				</div>
				{requests === undefined ? (
					<p className="muted box__body">Loading…</p>
				) : requests.length === 0 ? (
					<p className="muted box__body">No requests waiting.</p>
				) : (
					<ul className="manage__rows">
						{requests.map((r) => {
							const key = `request:${r.email}`;
							return (
								<li key={r.email} className="manage__row">
									<div className="manage__row-main">
										<strong>{r.email}</strong>
										<span className="muted">
											{r.orgs.map((o) => `@${o.org} as ${o.role}, asked by ${o.invitedBy}`).join("; ")} ·{" "}
											{timeAgo(r.createdAt, now)}
										</span>
										{errorFor(key)}
									</div>
									<div className="manage__row-actions">
										<button
											type="button"
											className="accent manage__small"
											disabled={busy !== null}
											onClick={() => run(key, () => actions.approve(r.email), rowFailed(key))}
										>
											{busy === key ? "Approving…" : "Approve"}
										</button>
										<ConfirmButton
											id={`decline:${r.email}`}
											confirming={confirming}
											setConfirming={setConfirming}
											label="Turn down"
											question={`Turn down ${r.email}?`}
											busy={busy === `decline:${r.email}`}
											onConfirm={() => run(`decline:${r.email}`, () => actions.decline(r.email), rowFailed(key))}
										/>
									</div>
								</li>
							);
						})}
					</ul>
				)}
			</section>

			<section className="box" aria-labelledby="admin-invites">
				<div className="box__header">
					<h2 id="admin-invites">Who can sign in</h2>
				</div>
				<form className="box__body manage__form" onSubmit={approveEmail}>
					<div className="manage__inline">
						<label htmlFor="admin-email" className="sr-only">
							Email to approve
						</label>
						<input
							id="admin-email"
							type="email"
							value={email}
							onChange={(e) => setEmail(e.target.value)}
							placeholder="person@example.com"
							autoComplete="off"
						/>
						<button type="submit" className="accent" disabled={!email.trim() || busy === "approve-email"}>
							{busy === "approve-email" ? "Approving…" : "Approve an email"}
						</button>
					</div>
					<p className="manage__hint">
						They sign in with GitHub or Google, with this email verified there. Removing one doesn't sign out someone
						already signed in.
					</p>
					{emailError ? (
						<p className="error manage__note" role="alert">
							{emailError}
						</p>
					) : null}
				</form>
				{invites === undefined ? (
					<p className="muted box__body">Loading…</p>
				) : invites.length === 0 ? (
					<p className="muted box__body">Nobody is approved yet.</p>
				) : (
					<ul className="manage__rows">
						{invites.map((i) => {
							const key = `invite:${i.email}`;
							return (
								<li key={i.email} className="manage__row">
									<div className="manage__row-main">
										<strong>{i.email}</strong>
										<span className="muted">
											approved by {i.invitedBy} · {timeAgo(i.createdAt, now)}
										</span>
										{errorFor(key)}
									</div>
									<div className="manage__row-actions">
										<ConfirmButton
											id={key}
											confirming={confirming}
											setConfirming={setConfirming}
											label="Remove"
											question={`Stop ${i.email} signing in?`}
											busy={busy === key}
											onConfirm={() => run(key, () => actions.removeInvite(i.email), rowFailed(key))}
										/>
									</div>
								</li>
							);
						})}
					</ul>
				)}
			</section>

			<section className="box" aria-labelledby="admin-hosted">
				<div className="box__header">
					<h2 id="admin-hosted">Hosted agents</h2>
				</div>
				<form className="box__body manage__form" onSubmit={allowPerson}>
					<p className="manage__hint">
						GitHive's hosted agents (build, request_review) run on GitHive's model account, so only the people listed
						here can start them.
					</p>
					<div className="manage__inline">
						<label htmlFor="admin-hosted-handle" className="sr-only">
							Handle to allow
						</label>
						<input
							id="admin-hosted-handle"
							type="text"
							value={handle}
							onChange={(e) => setHandle(e.target.value)}
							placeholder="handle"
							autoComplete="off"
							spellCheck={false}
						/>
						<button type="submit" className="accent" disabled={!handle.trim() || busy === "allow-hosted"}>
							{busy === "allow-hosted" ? "Allowing…" : "Allow a person"}
						</button>
					</div>
					<p className="manage__hint">By their handle; they need to have signed in once.</p>
					{handleError ? (
						<p className="error manage__note" role="alert">
							{handleError}
						</p>
					) : null}
				</form>
				{hosted === undefined ? (
					<p className="muted box__body">Loading…</p>
				) : hosted.length === 0 ? (
					<p className="muted box__body">Nobody may start hosted agents yet.</p>
				) : (
					<ul className="manage__rows">
						{hosted.map((h) => {
							const key = `hosted:${h.handle}`;
							return (
								<li key={h.handle} className="manage__row">
									<div className="manage__row-main">
										<strong>{h.handle}</strong>
										<span className="muted">
											allowed by {h.grantedBy} · {timeAgo(h.createdAt, now)}
										</span>
										{errorFor(key)}
									</div>
									<div className="manage__row-actions">
										<ConfirmButton
											id={key}
											confirming={confirming}
											setConfirming={setConfirming}
											label="Remove"
											question={`Stop ${h.handle} starting hosted agents?`}
											busy={busy === key}
											onConfirm={() => run(key, () => actions.disallowHosted(h.handle), rowFailed(key))}
										/>
									</div>
								</li>
							);
						})}
					</ul>
				)}
			</section>
		</main>
	);
}

/** The Admin page: loads requests, approved emails and the hosted-agent list, and refreshes them after each action. */
export function AdminPage({ admin }: { admin: AdminApi }) {
	const requests = usePoll("admin:requests", admin.requests, 60_000);
	const invites = usePoll("admin:invites", admin.invites, 60_000);
	const hosted = usePoll("admin:hosted", admin.hosted, 60_000);
	const after =
		<A extends unknown[], R>(work: (...args: A) => Promise<R>) =>
		async (...args: A) => {
			const result = await work(...args);
			requests.refresh();
			invites.refresh();
			hosted.refresh();
			return result;
		};
	const actions: AdminActions = {
		approve: after(admin.approve),
		removeInvite: after(admin.removeInvite),
		decline: after(admin.decline),
		allowHosted: after(admin.allowHosted),
		disallowHosted: after(admin.disallowHosted),
	};
	return (
		<AdminView
			requests={requests.data}
			invites={invites.data}
			hosted={hosted.data}
			error={requests.error ?? invites.error ?? hosted.error}
			actions={actions}
		/>
	);
}
