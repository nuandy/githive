import type { TaskSettingsProps } from "../dashboard-contract";
import "./TaskSettings.css";

/** How changes on an open task are checked before they merge: the gate's verify commands and the review policy. */
export function TaskSettings({ task }: TaskSettingsProps) {
  const policy = task.review ?? { reviewers: [], required: 0, vetoes: [] };
  const verify = Array.isArray(task.verify) ? task.verify : [];
  const reviewers = Array.isArray(policy.reviewers) ? policy.reviewers : [];
  const vetoes = Array.isArray(policy.vetoes) ? policy.vetoes : [];
  const required = policy.required ?? 0;
  return (
    <section className="task-settings card" aria-labelledby="task-settings-title">
      <h2 id="task-settings-title">Merge checks</h2>
      <div className="task-settings__grid">
        <section className="task-settings__block">
          <h3>Verify commands</h3>
          {verify.length ? <ul>{verify.map((command, index) => <li key={`${command}-${index}`}><code>{command}</code></li>)}</ul> : <p className="muted">No gate commands.</p>}
        </section>
        <section className="task-settings__block">
          <h3>Review policy</h3>
          <p>{required} approval{required === 1 ? "" : "s"} required</p>
          <p><span className="muted">Reviewer roles: </span>{reviewers.length ? reviewers.join(", ") : "None"}</p>
          <p><span className="muted">Veto roles: </span>{vetoes.length ? vetoes.join(", ") : "None"}</p>
          {typeof task.leaseMinutes === "number" ? <p><span className="muted">Claims expire after </span>{task.leaseMinutes} min without activity</p> : null}
        </section>
      </div>
    </section>
  );
}
