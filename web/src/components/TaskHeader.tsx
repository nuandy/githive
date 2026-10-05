import { useState } from "react";
import type { TaskHeaderProps } from "../dashboard-contract";
import "./TaskHeader.css";

/** Open tasks sit in the "building" phase for good; show that as "open". Older tasks keep their phase. */
export function taskPhaseLabel(phase: string): string {
  return phase === "building" ? "open" : phase;
}

export function TaskHeader({ task, busy }: TaskHeaderProps) {
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
          <span className="badge accent">{taskPhaseLabel(task.phase)}</span>
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
        {busy ? <span className="muted" role="status">Working…</span> : null}
      </div>
    </section>
  );
}
