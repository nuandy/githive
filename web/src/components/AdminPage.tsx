import type { ReactNode } from "react";
import type { AdminApi, ApprovedEmail, HostedUser, InviteRequest } from "../api";
import { usePoll } from "../hooks/usePoll";
import { type RunAction, useRowActions } from "../hooks/useRowActions";
import { AdminHosted } from "./AdminHosted";
import { AdminInvites } from "./AdminInvites";
import { AdminRequests } from "./AdminRequests";
import { Callout } from "./ui/box";
import { ManageHeader, ManagePage } from "./ui/manage";

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

/** What each section of the Admin page gets from the page: the actions, the busy and error state, and the time. */
export interface AdminSectionProps {
	actions: AdminActions;
	run: RunAction;
	/** Shows a failed action's message under the row with this key. */
	failed: (key: string) => (text: string) => void;
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
	const sectionProps: AdminSectionProps = { actions, now, ...useRowActions() };
	return (
		<ManagePage>
			<ManageHeader
				title="Admin"
				lede="Who may sign in to GitHive, and who may start its hosted agents. Only through Cloudflare Access."
			/>
			{error ? (
				<Callout tone="bad" className="animate-appear" role="alert">
					{error}
				</Callout>
			) : null}
			<AdminRequests requests={requests} {...sectionProps} />
			<AdminInvites invites={invites} {...sectionProps} />
			<AdminHosted hosted={hosted} {...sectionProps} />
		</ManagePage>
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
