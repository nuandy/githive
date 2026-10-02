import type { PlanPanelProps } from "../dashboard-contract";
import "./PlanPanel.css";

function statusTone(status?: string) {
  if (status === "done" || status === "approved") return "good";
  if (status === "failed" || status === "rejected") return "bad";
  if (status === "running" || status === "pending" || status === "stale") return "warn";
  return "";
}

export function PlanPanel({ task }: PlanPanelProps) {
  const policy = task.review ?? { reviewers: [], required: 0, vetoes: [] };
  const contracts = Array.isArray(task.contracts) ? task.contracts : [];
  const verify = Array.isArray(task.verify) ? task.verify : [];
  const amendments = Array.isArray(task.amendments) ? task.amendments : [];
  const reviewers = Array.isArray(policy.reviewers) ? policy.reviewers : [];
  const vetoes = Array.isArray(policy.vetoes) ? policy.vetoes : [];
  return (
    <section className="plan-panel card" aria-labelledby="plan-panel-title">
      <div className="plan-panel__title-row">
        <h2 id="plan-panel-title">Plan</h2>
        {task.planner ? <span className={`badge ${statusTone(task.planner.status)}`}>Planner {task.planner.status}</span> : <span className="badge">Planner not started</span>}
      </div>
      {task.planner?.error ? <p className="error plan-panel__planner-error">{task.planner.error}</p> : null}
      <div className="plan-panel__grid">
        <section className="plan-panel__block plan-panel__rationale">
          <h3>Rationale</h3>
          <p>{task.rationale || "No rationale provided."}</p>
        </section>
        <section className="plan-panel__block">
          <h3>Contract files</h3>
          {contracts.length ? <ul>{contracts.map((path) => <li key={path}><code>{path}</code></li>)}</ul> : <p className="muted">None</p>}
        </section>
        <section className="plan-panel__block">
          <h3>Verify commands</h3>
          {verify.length ? <ul>{verify.map((command, index) => <li key={`${command}-${index}`}><code>{command}</code></li>)}</ul> : <p className="muted">No gate commands.</p>}
        </section>
        <section className="plan-panel__block">
          <h3>Review policy</h3>
          <p>{policy.required ?? 0} approval{policy.required === 1 ? "" : "s"} required</p>
          <p><span className="muted">Reviewer roles: </span>{reviewers.length ? reviewers.join(", ") : "None"}</p>
          <p><span className="muted">Veto roles: </span>{vetoes.length ? vetoes.join(", ") : "None"}</p>
        </section>
      </div>
      <section className="plan-panel__amendments">
        <h3>Contract amendments</h3>
        {amendments.length ? (
          <ul className="plan-panel__amendment-list">
            {amendments.map((amendment) => (
              <li className="plan-panel__amendment" key={amendment.id}>
                <div className="plan-panel__amendment-head">
                  <code>{amendment.path}</code>
                  <span className={`badge ${statusTone(amendment.status)}`}>{amendment.status}</span>
                </div>
                <p><span className="muted">Proposed by </span>{amendment.slice}</p>
                <p>{amendment.reason}</p>
                {amendment.decision ? <p><span className="muted">Decision: </span>{amendment.decision}</p> : null}
              </li>
            ))}
          </ul>
        ) : <p className="muted">No amendments proposed.</p>}
      </section>
    </section>
  );
}
