import { useCallback, useEffect, useRef, useState } from "react";
import { api, type Live, type Task } from "./api";
import {
	ActivityFeed,
	DashboardSidebar,
	MergeAheadMatrix,
	PlanPanel,
	SliceLanes,
	TaskHeader,
	TokenSettings,
} from "./components";
import { newestTasks } from "./lib/dashboardData";
import type { DashboardShellAction, DashboardShellApi, DashboardTimerScheduler } from "./dashboard-contract";
import "./App.css";

export function taskIdFromHash(hash: string): string | null {
	const match = /^#\/tasks\/([^/]+)\/?$/.exec(hash);
	if (!match) return null;
	try {
		return decodeURIComponent(match[1]);
	} catch {
		return null;
	}
}

export const defaultDashboardScheduler: DashboardTimerScheduler = {
	setInterval: (callback, milliseconds) => window.setInterval(callback, milliseconds),
	clearInterval: (timer) => window.clearInterval(timer),
};

export function recordDashboardError(errors: string[], operation: string, error: unknown): string[] {
	const detail = error instanceof Error ? error.message : String(error);
	const message = `${operation}: ${detail}`;
	return errors.includes(message) ? errors : [...errors, message];
}

export function clearDashboardError(errors: string[], operation: string): string[] {
	return errors.filter((entry) => !entry.startsWith(`${operation}:`));
}

export class DashboardOperationError extends Error {
	constructor(readonly operation: string, cause: unknown) {
		super(cause instanceof Error ? cause.message : String(cause));
		this.name = "DashboardOperationError";
	}
}

export async function createTaskAndPlan(shellApi: DashboardShellApi, repo: string, goal: string): Promise<Task> {
	let task: Task;
	try {
		task = await shellApi.create(repo, goal);
	} catch (error) {
		throw new DashboardOperationError("Create task", error);
	}
	try {
		return await shellApi.plan(task.id);
	} catch (error) {
		throw new DashboardOperationError("Start planning", error);
	}
}

export async function runDashboardAction(shellApi: DashboardShellApi, id: string, action: DashboardShellAction): Promise<void> {
	if (action === "plan") {
		await shellApi.plan(id);
	} else if (action === "approve-build") {
		await shellApi.approve(id);
		await shellApi.build(id);
	} else {
		await shellApi.land(id);
	}
}

export function startDashboardPolling(
	id: string,
	getSelectedId: () => string | null,
	shellApi: Pick<DashboardShellApi, "live">,
	onLive: (result: Live) => void,
	onError: (error: unknown) => void,
	scheduler: DashboardTimerScheduler = defaultDashboardScheduler,
): () => void {
	let active = true;
	const poll = async () => {
		try {
			const result = await shellApi.live(id);
			if (active && getSelectedId() === id) onLive(result);
		} catch (error) {
			if (active && getSelectedId() === id) onError(error);
		}
	};
	void poll();
	const timer = scheduler.setInterval(() => void poll(), 3_000);
	return () => {
		active = false;
		scheduler.clearInterval(timer);
	};
}

export function startTaskListPolling(fetchTasks: () => void, scheduler: DashboardTimerScheduler = defaultDashboardScheduler): () => void {
	const timer = scheduler.setInterval(fetchTasks, 10_000);
	return () => scheduler.clearInterval(timer);
}

export function App() {
	const [tasks, setTasks] = useState<Task[]>([]);
	const [repos, setRepos] = useState<{ name: string }[]>([]);
	const [selectedId, setSelectedId] = useState<string | null>(() => taskIdFromHash(window.location.hash));
	const [live, setLive] = useState<Live | null>(null);
	const [tasksLoaded, setTasksLoaded] = useState(false);
	const [reposLoaded, setReposLoaded] = useState(false);
	const [creating, setCreating] = useState(false);
	const [busy, setBusy] = useState(false);
	const [errors, setErrors] = useState<string[]>([]);
	const selectedRef = useRef(selectedId);
	selectedRef.current = selectedId;

	const reportError = useCallback((operation: string, error: unknown) => {
		setErrors((current) => recordDashboardError(current, operation, error));
	}, []);
	const clearError = useCallback((operation: string) => {
		setErrors((current) => clearDashboardError(current, operation));
	}, []);

	const fetchTasks = useCallback(async () => {
		try {
			const result = await api.tasks();
			setTasks(newestTasks(result));
			setTasksLoaded(true);
			clearError("Tasks");
		} catch (error) {
			reportError("Tasks", error);
		}
	}, [clearError, reportError]);

	const fetchRepos = useCallback(async () => {
		try {
			setRepos(await api.repos());
			setReposLoaded(true);
			clearError("Repositories");
		} catch (error) {
			reportError("Repositories", error);
		}
	}, [clearError, reportError]);

	const refresh = useCallback(async () => {
		await Promise.all([fetchTasks(), fetchRepos()]);
	}, [fetchRepos, fetchTasks]);

	useEffect(() => {
		void refresh();
		return startTaskListPolling(() => void fetchTasks());
	}, [fetchTasks, refresh]);

	useEffect(() => {
		const onHashChange = () => setSelectedId(taskIdFromHash(window.location.hash));
		window.addEventListener("hashchange", onHashChange);
		return () => window.removeEventListener("hashchange", onHashChange);
	}, []);

	const selectTask = useCallback((id: string) => {
		setSelectedId(id);
		const nextHash = `#/tasks/${encodeURIComponent(id)}`;
		if (window.location.hash !== nextHash) window.location.hash = nextHash;
	}, []);

	useEffect(() => {
		if (!selectedId) {
			setLive(null);
			return;
		}
		const id = selectedId;
		return startDashboardPolling(
			id,
			() => selectedRef.current,
			api,
			(result) => {
				setLive(result);
				setTasks((existing) => newestTasks([
					...existing.filter((task) => task.id !== result.task.id),
					result.task,
				]));
				clearError("Live task");
			},
			(error) => reportError("Live task", error),
		);
	}, [clearError, selectedId, reportError]);

	const selectedTask = live?.task.id === selectedId
		? live.task
		: tasks.find((task) => task.id === selectedId) ?? null;

	const createTask = useCallback(async (repo: string, goal: string) => {
		setCreating(true);
		const shellApi: DashboardShellApi = {
			...api,
			create: async (selectedRepo, selectedGoal) => {
				const task = await api.create(selectedRepo, selectedGoal);
				setTasks((current) => newestTasks([...current.filter((item) => item.id !== task.id), task]));
				clearError("Create task");
				selectTask(task.id);
				return task;
			},
		};
		try {
			const planned = await createTaskAndPlan(shellApi, repo, goal);
			setTasks((current) => newestTasks([...current.filter((item) => item.id !== planned.id), planned]));
			clearError("Start planning");
			await refresh();
		} catch (error) {
			const operation = error instanceof DashboardOperationError ? error.operation : "Create task";
			reportError(operation, error);
		} finally {
			setCreating(false);
		}
	}, [clearError, refresh, reportError, selectTask]);

	const runAction = useCallback(async (action: DashboardShellAction) => {
		if (!selectedTask || busy) return;
		const id = selectedTask.id;
		const operation = action === "approve-build" ? "Approve and build" : action === "plan" ? "Plan" : "Land";
		setBusy(true);
		try {
			await runDashboardAction(api, id, action);
			if (action === "plan") clearError("Start planning");
			clearError(operation);
		} catch (error) {
			reportError(operation, error);
		} finally {
			await refresh();
			setBusy(false);
		}
	}, [busy, clearError, refresh, reportError, selectedTask]);

	const plannerRunning = selectedTask?.planner?.status === "running";
	const showingLive = live?.task.id === selectedId ? live : null;

	return (
		<div className="shell dashboard-shell">
			<header className="topbar dashboard-topbar">
				<a className="brand" href="#/">Blueprint</a>
				<div className="dashboard-topbar-actions"><TokenSettings /></div>
			</header>
			<div className="dashboard-frame">
				<aside className="dashboard-sidebar">
					<DashboardSidebar
						tasks={newestTasks(tasks)}
						repos={repos}
						selectedId={selectedId}
						taskLoading={!tasksLoaded}
						creating={creating}
						onSelect={selectTask}
						onCreate={(repo, goal) => void createTask(repo, goal)}
					/>
				</aside>
				<main className="dashboard-content">
					{errors.length > 0 && (
						<div className="dashboard-errors" role="alert" aria-live="polite">
							<strong>Some dashboard requests failed</strong>
							<ul>{errors.map((error) => <li key={error}>{error}</li>)}</ul>
						</div>
					)}
					{!selectedTask ? (
						<section className="dashboard-empty card">
							<h1>{tasksLoaded && tasks.length === 0 ? "No tasks yet" : selectedId ? "Loading task…" : "Blueprint dashboard"}</h1>
							<p className="muted">{tasksLoaded && tasks.length === 0 ? "Create a task to start planning and building." : selectedId ? "The selected task will appear here when it is available." : "Choose a task or create a new one to get started."}</p>
							{!reposLoaded && <p className="muted">Loading repositories…</p>}
						</section>
					) : (
						<div className="dashboard-task">
							<TaskHeader
								task={selectedTask}
								plannerRunning={plannerRunning}
								busy={busy}
								onPlan={() => void runAction("plan")}
								onApproveAndBuild={() => void runAction("approve-build")}
								onLand={() => void runAction("land")}
							/>
							<PlanPanel task={selectedTask} />
							{showingLive && <SliceLanes live={showingLive} />}
							<MergeAheadMatrix task={selectedTask} />
							{showingLive && <ActivityFeed agents={showingLive.agents} />}
							{!showingLive && <p className="muted dashboard-live-pending">Loading live slice activity…</p>}
						</div>
					)}
				</main>
			</div>
		</div>
	);
}
