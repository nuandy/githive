import type { Live, Task } from "./api";

export type DashboardSliceStage = "building" | "in-review" | "gate" | "integrated" | "needs-human";
export interface SliceStageInfo {
  stage: DashboardSliceStage;
  revisions: number;
}

export type MatrixStatus = "clean" | "disjoint" | "conflict" | "unchecked" | "same";
export interface MergeMatrixCell {
  row: string;
  column: string;
  status: MatrixStatus;
  files: string[];
  checkedAt?: string;
}
export interface MergeMatrix {
  ids: string[];
  cells: MergeMatrixCell[][];
}

export interface ActivityItem {
  id: string;
  sliceId: string;
  agent: string;
  at: string;
  event: string;
}

export declare function getSliceStage(slice: Task["slices"][number]): SliceStageInfo;
export declare function buildMergeMatrix(task: Task): MergeMatrix;
export declare function mergeActivity(agents: Live["agents"], includeCommands?: boolean): ActivityItem[];
export declare function newestTasks(tasks: Task[]): Task[];

export interface DashboardSidebarProps {
  tasks: Task[];
  repos: { name: string }[];
  selectedId: string | null;
  taskLoading: boolean;
  creating: boolean;
  onSelect(id: string): void;
  onCreate(repo: string, goal: string): void;
}
export interface TaskHeaderProps {
  task: Task;
  plannerRunning: boolean;
  busy: boolean;
  onPlan(): void;
  onApproveAndBuild(): void;
  onLand(): void;
}
export interface PlanPanelProps { task: Task }
export interface SliceLanesProps { live: Live }
export interface MergeAheadMatrixProps { task: Task }
export interface ActivityFeedProps { agents: Live["agents"] }

/** Injected I/O surface used by the dashboard shell and its orchestration tests. */
export interface DashboardShellApi {
  tasks(): Promise<Task[]>;
  repos(): Promise<{ name: string }[]>;
  live(id: string): Promise<Live>;
  create(repo: string, goal: string): Promise<Task>;
  plan(id: string): Promise<Task>;
  approve(id: string): Promise<unknown>;
  build(id: string): Promise<unknown>;
  land(id: string): Promise<Task>;
}

export type DashboardShellAction = "plan" | "approve-build" | "land";
export interface DashboardTimerScheduler {
  setInterval(callback: () => void, milliseconds: number): number;
  clearInterval(timer: number): void;
}

export declare function taskIdFromHash(hash: string): string | null;
export declare function createTaskAndPlan(api: DashboardShellApi, repo: string, goal: string): Promise<Task>;
export declare function runDashboardAction(api: DashboardShellApi, id: string, action: DashboardShellAction): Promise<void>;
export declare function startDashboardPolling(
  id: string,
  getSelectedId: () => string | null,
  api: Pick<DashboardShellApi, "live">,
  onLive: (live: Live) => void,
  onError: (error: unknown) => void,
  scheduler?: DashboardTimerScheduler,
): () => void;
export declare function startTaskListPolling(
  fetchTasks: () => void,
  scheduler?: DashboardTimerScheduler,
): () => void;
export declare function recordDashboardError(errors: string[], operation: string, error: unknown): string[];
export declare function clearDashboardError(errors: string[], operation: string): string[];
export declare const defaultDashboardScheduler: DashboardTimerScheduler;
