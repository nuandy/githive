import { useCallback, useEffect, useRef, useState } from "react";
import { api, type FreeSnapshot, type Live, type Task } from "./api";
import { FreeRepoList, FreeRepoView } from "./components/FreeRepoView";
import {
	ActivityFeed,
	CodeDecisions,
	DashboardSidebar,
	LaneChangeRequests,
	MergeAheadMatrix,
	SliceLanes,
	TaskDetailBoundary,
	TaskHeader,
	TaskSettings,
} from "./components";
import { newestTasks } from "./lib/dashboardData";
import type { DashboardShellApi, DashboardTimerScheduler } from "./dashboard-contract";
import "./App.css";

/** The coordinator-free repo a #/free/<repo> address names, if any. */
export function freeRepoFromHash(hash: string): string | null {
	const match = /^#\/free\/([^/]+)\/?$/.exec(hash);
	return match ? decodeURIComponent(match[1]) : null;
}

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
	const [selectionEpoch, setSelectionEpoch] = useState(0);
	const selectionEpochRef = useRef(0);
	const [live, setLive] = useState<Live | null>(null);
	const [tasksLoaded, setTasksLoaded] = useState(false);
	const [reposLoaded, setReposLoaded] = useState(false);
	const [opening, setOpening] = useState(false);
	const [busy, setBusy] = useState(false);
	const [errors, setErrors] = useState<string[]>([]);
	const [freeRepos, setFreeRepos] = useState<{ repo: string; since: string }[]>([]);
	const [freeRepo, setFreeRepo] = useState<string | null>(() => freeRepoFromHash(window.location.hash));
	const [freeSnapshot, setFreeSnapshot] = useState<FreeSnapshot | null>(null);
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

	const fetchFreeRepos = useCallback(async () => {
		try {
			setFreeRepos(await api.freeRepos());
			clearError("Coordinator-free repos");
		} catch (error) {
			reportError("Coordinator-free repos", error);
		}
	}, [clearError, reportError]);

	const refresh = useCallback(async () => {
		await Promise.all([fetchTasks(), fetchRepos(), fetchFreeRepos()]);
	}, [fetchFreeRepos, fetchRepos, fetchTasks]);

	// A coordinator-free repo's view: refreshed every few seconds while it is open.
	useEffect(() => {
		const onHashChange = () => setFreeRepo(freeRepoFromHash(window.location.hash));
		window.addEventListener("hashchange", onHashChange);
		return () => window.removeEventListener("hashchange", onHashChange);
	}, []);
	useEffect(() => {
		setFreeSnapshot(null);
		if (!freeRepo) return;
		let active = true;
		const poll = async () => {
			try {
				const snapshot = await api.freeRepo(freeRepo);
				if (active) setFreeSnapshot(snapshot);
				clearError("Coordinator-free repo");
			} catch (error) {
				if (active) reportError("Coordinator-free repo", error);
			}
		};
		void poll();
		const timer = setInterval(() => void poll(), 5_000);
		return () => {
			active = false;
			clearInterval(timer);
		};
	}, [clearError, freeRepo, reportError]);

	useEffect(() => {
		void refresh();
		return startTaskListPolling(() => void fetchTasks());
	}, [fetchTasks, refresh]);

	const changeSelection = useCallback((id: string | null) => {
		if (selectedRef.current !== id) {
			const nextEpoch = selectionEpochRef.current + 1;
			selectionEpochRef.current = nextEpoch;
			setSelectionEpoch(nextEpoch);
			selectedRef.current = id;
		}
		setSelectedId(id);
	}, []);

	useEffect(() => {
		const onHashChange = () => changeSelection(taskIdFromHash(window.location.hash));
		window.addEventListener("hashchange", onHashChange);
		return () => window.removeEventListener("hashchange", onHashChange);
	}, [changeSelection]);

	const selectTask = useCallback((id: string) => {
		changeSelection(id);
		const nextHash = `#/tasks/${encodeURIComponent(id)}`;
		if (window.location.hash !== nextHash) window.location.hash = nextHash;
	}, [changeSelection]);

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
	const openRepo = useCallback(async (repo: string) => {
		setOpening(true);
		try {
			const task = await api.openRepo(repo);
			setTasks((current) => newestTasks([...current.filter((item) => item.id !== task.id), task]));
			clearError("Open repo");
			selectTask(task.id);
			await fetchTasks();
		} catch (error) {
			reportError("Open repo", error);
		} finally {
			setOpening(false);
		}
	}, [clearError, fetchTasks, reportError, selectTask]);

	const waiveSlice = useCallback(async (sliceId: string, reason: string) => {
		if (!selectedTask || busy) return;
		const id = selectedTask.id;
		const operation = "Waive human review: " + sliceId;
		setBusy(true);
		try {
			await api.waive(id, sliceId, reason);
			clearError(operation);
		} catch (error) {
			reportError(operation, error);
		} finally {
			await refresh();
			setBusy(false);
		}
	}, [busy, clearError, refresh, reportError, selectedTask]);
	const showingLive = live?.task.id === selectedId ? live : null;

	return (
		<div className="shell dashboard-shell">
			<header className="topbar dashboard-topbar">
				<a className="brand" href="#/">Blueprint</a>
			</header>
			<div className="dashboard-frame">
				<aside className="dashboard-sidebar">
					<DashboardSidebar
						tasks={newestTasks(tasks)}
						repos={repos}
						selectedId={selectedId}
						taskLoading={!tasksLoaded}
						opening={opening}
						onSelect={selectTask}
						onOpenRepo={(repo) => void openRepo(repo)}
					/>
					<FreeRepoList repos={freeRepos} selected={freeRepo} />
				</aside>
				<main className="dashboard-content">
					{errors.length > 0 && (
						<div className="dashboard-errors" role="alert" aria-live="polite">
							<strong>Some dashboard requests failed</strong>
							<ul>{errors.map((error) => <li key={error}>{error}</li>)}</ul>
						</div>
					)}
					{freeRepo ? (
						freeSnapshot ? (
							<FreeRepoView snapshot={freeSnapshot} />
						) : (
							<section className="dashboard-empty card">
								<h1>Loading {freeRepo}…</h1>
							</section>
						)
					) : !selectedTask ? (
						<section className="dashboard-empty card">
							<h1>{tasksLoaded && tasks.length === 0 ? "No repos open yet" : selectedId ? "Loading task…" : "Blueprint dashboard"}</h1>
							<p className="muted">{tasksLoaded && tasks.length === 0
								? <>Open a repo for agents from the sidebar, or let agents join one themselves with the MCP <code>join_repo</code> tool.</>
								: selectedId ? "The selected task will appear here when it is available." : "Choose an open repo, or open a new one for agents."}</p>
							{!reposLoaded && <p className="muted">Loading repositories…</p>}
						</section>
					) : (
						<TaskDetailBoundary key={`${selectedTask.id}:${selectionEpoch}`}>
							<div className="dashboard-task">
								<TaskHeader task={selectedTask} busy={busy} />
								<TaskSettings task={selectedTask} />
								<CodeDecisions
									task={selectedTask}
									busy={busy}
									onWaive={(sliceId, reason) => void waiveSlice(sliceId, reason)}
								/>
								{showingLive && <SliceLanes live={showingLive} />}
								<LaneChangeRequests task={selectedTask} />
								<MergeAheadMatrix task={selectedTask} />
								{showingLive && <ActivityFeed agents={showingLive.agents} />}
								{!showingLive && <p className="muted dashboard-live-pending">Loading live slice activity…</p>}
							</div>
						</TaskDetailBoundary>
					)}
				</main>
			</div>
		</div>
	);
}
