import { useEffect, useState } from "react";
import { api, type Task } from "./api";

// Placeholder shell: lists tasks. The dashboard task replaces this.
export function App() {
	const [tasks, setTasks] = useState<Task[] | null>(null);
	const [error, setError] = useState("");

	useEffect(() => {
		api.tasks().then(setTasks, (e: Error) => setError(e.message));
	}, []);

	return (
		<div className="shell">
			<header className="topbar">
				<span className="brand">Blueprint</span>
			</header>
			<main className="content">
				{error && <p className="error">{error}</p>}
				{!tasks && !error && <p className="muted">Loading…</p>}
				{tasks?.length === 0 && <p className="muted">No tasks yet.</p>}
				<ul className="stack">
					{tasks?.map((t) => (
						<li key={t.id} className="card">
							<strong>{t.id}</strong> <span className="badge">{t.phase}</span>
							<p>{t.goal}</p>
						</li>
					))}
				</ul>
			</main>
		</div>
	);
}
