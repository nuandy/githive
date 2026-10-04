import type { FreeSnapshot } from "../api";
import { formatRelativeTime } from "../lib/relativeTime";
import "./FreeRepoView.css";

// A repo in coordinator-free mode: nothing enforces the rules there, so this is
// where people see who holds what, how reviews stand, and what the audit found,
// including violations a revert has since resolved.

const short = (commit: string) => commit.slice(0, 8);

export function FreeRepoView({ snapshot }: { snapshot: FreeSnapshot }) {
	const { policy, verify, claims, votes, audit } = snapshot;
	const open = audit.violations.filter((v) => !v.resolvedBy);
	const resolved = audit.violations.filter((v) => v.resolvedBy);
	return (
		<div className="free-repo">
			<header className="free-repo__header card">
				<h1>{snapshot.repo}</h1>
				<p className="muted">
					Coordinator-free mode: agents follow the conventions themselves, and the audit, read from Git, shows who didn't.
				</p>
				<ul className="free-repo__settings">
					<li>
						Merging needs {policy.required} approvals{policy.vetoes.length ? `; ${policy.vetoes.join(", ")} can veto` : ""}
					</li>
					<li>{verify.length ? <>Checks before merging: {verify.map((c) => <code key={c}>{c}</code>)}</> : "No checks before merging"}</li>
					<li>{snapshot.verified ? "Records and merges are stamped with verified identity" : "Records are not stamped: names are as agents give them"}</li>
					<li>
						{snapshot.access === "forks"
							? "Each change in its own fork: agents can't write main; only the toolkit merges, once the conventions hold"
							: "Shared repo: every agent can write main, so the audit is the only check"}
					</li>
				</ul>
			</header>

			<section className="card">
				<h2>
					Audit <span className={open.length ? "free-repo__badge free-repo__badge--bad" : "free-repo__badge"}>{open.length} open</span>
				</h2>
				<p className="muted">{audit.merges} commits on main since the mode started.</p>
				{audit.violations.length === 0 ? <p>No violations.</p> : null}
				{open.length > 0 && <Violations title="Open" violations={open} />}
				{resolved.length > 0 && <Violations title="Resolved" violations={resolved} />}
			</section>

			<section className="card">
				<h2>Claims in force</h2>
				{claims.length === 0 ? (
					<p className="muted">Nobody holds a claim.</p>
				) : (
					<table className="free-repo__table">
						<thead>
							<tr>
								<th>Change</th>
								<th>Paths</th>
								<th>Intent</th>
								<th>Agent</th>
								<th>Status</th>
								<th>Active</th>
							</tr>
						</thead>
						<tbody>
							{claims.map((c) => (
								<tr key={c.change}>
									<td>
										<code>{c.change}</code>
									</td>
									<td>{c.paths.map((p) => <code key={p}>{p}</code>)}</td>
									<td>{c.intent}</td>
									<td>
										{c.agent}
										{c.by ? <span className="muted"> · {c.by}</span> : null}
									</td>
									<td>
										<ChangeStatus claim={c} />
									</td>
									<td className="muted">{c.active ? formatRelativeTime(c.active) : ""}</td>
								</tr>
							))}
						</tbody>
					</table>
				)}
			</section>

			<section className="card">
				<h2>Recent votes</h2>
				{votes.length === 0 ? (
					<p className="muted">No votes yet.</p>
				) : (
					<table className="free-repo__table">
						<tbody>
							{votes.map((v) => (
								<tr key={`${v.reviewer}-${v.commit}-${v.at}`}>
									<td>
										<code>{short(v.commit)}</code>
									</td>
									<td className={v.verdict === "approve" ? "free-repo__approve" : "free-repo__reject"}>{v.verdict}</td>
									<td>
										{v.reviewer} ({v.role}){v.by ? <span className="muted"> · {v.by}</span> : null}
									</td>
									<td>{v.evidence}</td>
								</tr>
							))}
						</tbody>
					</table>
				)}
			</section>
		</div>
	);
}

/** Where a claimed change stands: its pushed head and approvals, and Blueprint's hosted agents on it. */
function ChangeStatus({ claim }: { claim: FreeSnapshot["claims"][number] }) {
	const { head, approval, hosted } = claim;
	const builder = hosted?.builder;
	return (
		<div className="free-repo__status">
			{head ? (
				<div>
					<code>{short(head)}</code> {approval.approvals} of {approval.required} approvals
					{approval.vetoedBy.length ? <span className="free-repo__reject"> · vetoed by {approval.vetoedBy.join(", ")}</span> : null}
				</div>
			) : (
				<div className="muted">nothing pushed yet</div>
			)}
			{builder ? (
				<div className={builder.status === "failed" ? "free-repo__reject" : "muted"}>
					builder {builder.status}
					{builder.revisions ? ` (revision ${builder.revisions})` : ""}
					{builder.error ? `: ${builder.error}` : ""}
				</div>
			) : null}
			{hosted?.reviewers.map((r) => (
				<div key={r.role} className="muted">
					{r.role}: {r.verdict ?? r.status}
				</div>
			))}
		</div>
	);
}

function Violations({ title, violations }: { title: string; violations: FreeSnapshot["audit"]["violations"] }) {
	return (
		<>
			<h3>{title}</h3>
			<ul className="free-repo__violations">
				{violations.map((v, i) => (
					<li key={`${v.commit}-${v.rule}-${i}`} className={v.resolvedBy ? "free-repo__violation free-repo__violation--resolved" : "free-repo__violation"}>
						<code>{short(v.commit)}</code> <strong>{v.rule}</strong> by {v.author}
						{v.by ? <span className="muted"> ({v.by})</span> : <span className="muted"> (unverified)</span>}
						<div className="muted">{v.detail}</div>
						{v.resolvedBy ? <div className="muted">resolved by {short(v.resolvedBy)}</div> : null}
					</li>
				))}
			</ul>
		</>
	);
}

/** Repos in coordinator-free mode, for the sidebar. */
export function FreeRepoList({ repos, selected }: { repos: { repo: string; since: string }[]; selected: string | null }) {
	if (!repos.length) return null;
	return (
		<section className="free-repo-list">
			<h2>Coordinator-free</h2>
			<ul>
				{repos.map((r) => (
					<li key={r.repo}>
						<a href={`#/free/${encodeURIComponent(r.repo)}`} aria-current={selected === r.repo ? "page" : undefined}>
							{r.repo}
						</a>
					</li>
				))}
			</ul>
		</section>
	);
}
