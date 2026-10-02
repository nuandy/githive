import { useState } from "react";
import type { TaskHeaderProps } from "../dashboard-contract";
import "./TaskHeader.css";

export function TaskHeader({ task, plannerRunning, busy, contractsReady, onPlan, onApproveAndBuild }: TaskHeaderProps) {
  const [expandedGoal, setExpandedGoal] = useState<{ taskId: string; expanded: boolean }>({ taskId: task.id, expanded: false });
  const isGoalExpanded = expandedGoal.taskId === task.id && expandedGoal.expanded;

  function toggleGoal() {
    setExpandedGoal((previous) => ({
      taskId: task.id,
      expanded: !(previous.taskId === task.id && previous.expanded),
    }));
  }

  return (
    <section className="task-header card" aria-labelledby="task-title">
      <div className="task-header__copy">
        <div className="task-header__meta">
          <span className="badge accent">{task.phase}</span>
          <span className="muted">{task.repo}</span>
        </div>
        <h1 id="task-title" className={isGoalExpanded ? "is-expanded" : undefined}>{task.goal}</h1>
        <button
          className="task-header__goal-toggle"
          type="button"
          aria-expanded={isGoalExpanded}
          aria-controls="task-title"
          onClick={toggleGoal}
        >
          {isGoalExpanded ? "Show less" : "Show more"}
        </button>
      </div>
      <div className="task-header__action">
        {task.phase === "planning" && !plannerRunning ? <button className="primary" type="button" onClick={onPlan} disabled={busy}>Plan</button> : null}
        {task.phase === "planning" && plannerRunning ? <span className="muted" role="status">Planning in progress…</span> : null}
        {task.phase === "awaiting-approval" ? <button className="primary" type="button" onClick={onApproveAndBuild} disabled={busy || !contractsReady}>Approve and build</button> : null}
        {busy ? <span className="muted" role="status">Working…</span> : null}
      </div>
    </section>
  );
}
