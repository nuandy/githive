import { useState, type FormEvent } from "react";
import type { DashboardSidebarProps } from "../dashboard-contract";
import { newestTasks } from "../lib/dashboardData";
import "./DashboardSidebar.css";

function phaseTone(phase: string) {
  if (phase === "landed") return "good";
  if (phase === "building") return "accent";
  if (phase === "awaiting-approval") return "warn";
  return "";
}

export function DashboardSidebar({ tasks, repos, selectedId, taskLoading, creating, onSelect, onCreate }: DashboardSidebarProps) {
  const [repo, setRepo] = useState("");
  const [goal, setGoal] = useState("");
  const canCreate = Boolean(repo && goal.trim() && !creating);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canCreate) return;
    onCreate(repo, goal.trim());
    setGoal("");
  }

  return (
    <aside className="dashboard-sidebar" aria-label="Tasks">
      <section className="dashboard-sidebar__section">
        <div className="dashboard-sidebar__heading">
          <h2>Tasks</h2>
          <span className="muted">{tasks.length}</span>
        </div>
        {taskLoading && tasks.length === 0 ? <p className="muted">Loading tasks…</p> : null}
        {!taskLoading && tasks.length === 0 ? <p className="muted">No tasks yet. Start with a goal below.</p> : null}
        <ul className="dashboard-sidebar__task-list">
          {newestTasks(tasks).map((task) => {
            const integrated = task.slices.filter((slice) => slice.status === "integrated").length;
            const total = task.slices.length;
            const selected = selectedId === task.id;
            return (
              <li key={task.id}>
                <button
                  type="button"
                  className={`dashboard-sidebar__task${selected ? " is-selected" : ""}`}
                  aria-current={selected ? "page" : undefined}
                  onClick={() => onSelect(task.id)}
                >
                  <span className="dashboard-sidebar__task-title" title={task.goal}>{task.goal}</span>
                  <span className="dashboard-sidebar__task-meta">
                    <span className={`badge ${phaseTone(task.phase)}`}>{task.phase}</span>
                    <span className="muted">{integrated}/{total} integrated</span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </section>

      <section className="dashboard-sidebar__section dashboard-sidebar__new-task">
        <h2>New task</h2>
        <form onSubmit={submit}>
          <label htmlFor="new-task-repo">Repository</label>
          <select id="new-task-repo" value={repo} onChange={(event) => setRepo(event.target.value)} required disabled={creating || repos.length === 0}>
            <option value="" disabled>{repos.length ? "Choose a repository" : "No repositories available"}</option>
            {repos.map((item) => <option key={item.name} value={item.name}>{item.name}</option>)}
          </select>
          <label htmlFor="new-task-goal">Goal</label>
          <textarea id="new-task-goal" value={goal} onChange={(event) => setGoal(event.target.value)} placeholder="What should the builders implement?" rows={3} required disabled={creating} />
          <button className="primary" type="submit" disabled={!canCreate}>{creating ? "Starting…" : "Create and plan"}</button>
        </form>
      </section>
    </aside>
  );
}
