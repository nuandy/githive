import { type ReactNode, useState } from "react";
import type { AdminApi, ApprovedEmail, HostedUser, InviteRequest } from "../api";
import { usePoll } from "../hooks/usePoll";
import { AdminHosted } from "./AdminHosted";
import { AdminInvites } from "./AdminInvites";
import { AdminRequests } from "./AdminRequests";
import { messageOf } from "./Confirm";
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

/** Runs one action, keyed so its button shows it's busy; resolves to whether it worked. */
export type RunAction = (
	key: string,
	work: () => Promise<unknown>,
	onError: (text: string) => void,
) => Promise<boolean>;

/** What each section of the Admin page gets from the page: the actions, the busy and error state, and the time. */
export interface AdminSectionProps {
	actions: AdminActions;
	run: RunAction;
	/** Shows a failed action's message under the row with this key. */
	rowFailed: (key: string) => (text: string) => void;
	errorFor: (key: string) => ReactNode;
	busy: string | null;
	confirming: string | null;
	setConfirming: (id: string | null) => void;
	now: number;
}

/**
 * GitHive's operators, through Cloudflare Access: orgs' requests to bring
 * someone in, who may sign in, and who may start GitHive's hosted agents.
 */
export function AdminView({ requests, invites, hosted, error, actions, now = Date.now() }: AdminViewProps) {
	const sectionProps: AdminSectionProps = { actions, now, ...useAdminRun() };
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
			<AdminRequests requests={requests} {...sectionProps} />
			<AdminInvites invites={invites} {...sectionProps} />
			<AdminHosted hosted={hosted} {...sectionProps} />
		</main>
	);
}

/** The state the Admin page's sections share: which action is busy, which question is open, and a row's error. */
function useAdminRun() {
	const [busy, setBusy] = useState<string | null>(null);
	const [confirming, setConfirming] = useState<string | null>(null);
	const [rowError, setRowError] = useState<{ key: string; text: string } | null>(null);

	const run: RunAction = async (key, work, onError) => {
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
	const errorFor = (key: string) => {
		if (rowError?.key !== key) return null;
		return (
			<p className="error manage__note" role="alert">
				{rowError.text}
			</p>
		);
	};
	return { run, rowFailed, errorFor, busy, confirming, setConfirming };
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
