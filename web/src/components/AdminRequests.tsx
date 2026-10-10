import type { InviteRequest } from "../api";
import { timeAgo } from "../lib/relativeTime";
import type { AdminSectionProps } from "./AdminPage";
import { AdminRow, AdminRows } from "./AdminRows";
import { ConfirmButton } from "./Confirm";

const PROVIDERS: Record<string, string> = { github: "GitHub", google: "Google" };

/** People waiting to be approved, whether an org invited them or they tried to sign in, to approve or turn down. */
export function AdminRequests({
	requests,
	actions,
	run,
	rowFailed,
	errorFor,
	busy,
	confirming,
	setConfirming,
	now,
}: AdminSectionProps & { requests: InviteRequest[] | undefined }) {
	return (
		<section className="box" aria-labelledby="admin-requests">
			<div className="box__header">
				<h2 id="admin-requests">Requests</h2>
			</div>
			<div className="box__body">
				<p className="manage__hint">
					People who can't sign in until you approve them: those an organization invited, who join it when they first
					sign in, and those who tried to sign in uninvited.
				</p>
			</div>
			<AdminRows items={requests} empty="No requests waiting.">
				{(request) => {
					const key = `request:${request.email}`;
					const declineKey = `decline:${request.email}`;
					return (
						<AdminRow
							key={request.email}
							name={request.email}
							detail={
								<>
									{requestWords(request)} · {timeAgo(request.createdAt, now)}
								</>
							}
							error={errorFor(key)}
						>
							<button
								type="button"
								className="accent manage__small"
								disabled={busy !== null}
								onClick={() => run(key, () => actions.approve(request.email), rowFailed(key))}
							>
								{busy === key ? "Approving…" : "Approve"}
							</button>
							<ConfirmButton
								id={declineKey}
								confirming={confirming}
								setConfirming={setConfirming}
								label="Turn down"
								question={`Turn down ${request.email}?`}
								busy={busy === declineKey}
								onConfirm={() => run(declineKey, () => actions.decline(request.email), rowFailed(key))}
							/>
						</AdminRow>
					);
				}}
			</AdminRows>
		</section>
	);
}

/** Who asked for someone, or how they asked themselves. */
function requestWords(request: InviteRequest) {
	const invitedBy = request.orgs.map((org) => `@${org.org} as ${org.role}, asked by ${org.invitedBy}`);
	const tried = request.signIn;
	if (!tried) return invitedBy.join("; ");
	const provider = PROVIDERS[tried.provider] ?? tried.provider;
	const who = tried.login ? ` as ${tried.login}` : "";
	const times = tried.tries === 1 ? "once" : `${tried.tries} times`;
	const signInWords = `tried to sign in with ${provider}${who}, ${times}`;
	return [...invitedBy, signInWords].join("; ");
}
