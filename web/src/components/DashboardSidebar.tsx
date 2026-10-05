import { useState, type FormEvent } from "react";
import type { DashboardSidebarProps } from "../dashboard-contract";
import { newestTasks } from "../lib/dashboardData";
import { taskPhaseLabel } from "./TaskHeader";
import "./DashboardSidebar.css";

function phaseTone(phase: string) {
  return phase === "building" ? "accent" : "";
}

export function DashboardSidebar({ tasks, repos, selectedId, taskLoading, opening, onSelect, onOpenRepo }: DashboardSidebarProps) {
  const [repo, setRepo] = useState("");
  const safeTasks = Array.isArray(tasks) ? tasks : [];
  const safeRepos = Array.isArray(repos) ? repos : [];
  const canOpen = Boolean(repo.trim() && !opening);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canOpen) return;
    onOpenRepo(repo.trim());
    setRepo("");
  }

  return (
    <aside className="dashboard-sidebar" aria-label="Tasks">
      <section className="dashboard-sidebar__section">
        <div className="dashboard-sidebar__heading">
          <h2>Tasks</h2>
          <span className="muted">{safeTasks.length}</span>
        </div>
        {taskLoading && safeTasks.length === 0 ? <p className="muted">Loading tasks…</p> : null}
        {!taskLoading && safeTasks.length === 0 ? <p className="muted">No repos open yet. Open one below.</p> : null}
        <ul className="dashboard-sidebar__task-list">
          {newestTasks(safeTasks).map((task) => {
            const slices = Array.isArray(task.slices) ? task.slices : [];
            const integrated = slices.filter((slice) => slice.status === "integrated").length;
            const total = slices.length;
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
                    <span className={`badge ${phaseTone(task.phase)}`}>{taskPhaseLabel(task.phase)}</span>
                    <span className="muted">{integrated}/{total} integrated</span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </section>

      <section className="dashboard-sidebar__section dashboard-sidebar__new-task">
        <h2>Open a repo</h2>
        <form onSubmit={submit}>
          <label htmlFor="open-repo-name">Repository</label>
          <input
            id="open-repo-name"
            type="text"
            list="open-repo-options"
            value={repo}
            onChange={(event) => setRepo(event.target.value)}
            placeholder={safeRepos.length ? "Choose or type a repository" : "Repository name"}
            autoComplete="off"
            required
            disabled={opening}
          />
          <datalist id="open-repo-options">
            {safeRepos.map((item) => <option key={item.name} value={item.name} />)}
          </datalist>
          <button className="primary" type="submit" disabled={!canOpen}>{opening ? "Opening…" : "Open for agents"}</button>
          <p className="muted dashboard-sidebar__hint">Agents can also join a repo themselves with the MCP <code>join_repo</code> tool.</p>
        </form>
      </section>
    </aside>
  );
}
