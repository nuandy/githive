import type { Live, Task } from "./api";

export type DashboardSliceStage = "building" | "in-review" | "gate" | "integrated" | "needs-human";
export interface SliceStageInfo {
  stage: DashboardSliceStage;
  revisions: number;
}

export type MatrixStatus = "clean" | "disjoint" | "conflict" | "unchecked" | "same" | "integrated";
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
/** Pure formatting helper. `now` is injectable so relative-time behavior is deterministic in tests. */
export declare function formatRelativeTime(isoTime: string, now?: number | Date): string;

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
  contractsReady: boolean;
  onPlan(): void;
  onApproveAndBuild(): void;
}
export interface PlanPanelProps { task: Task }
export interface SliceLanesProps { live: Live }
export interface LaneChangeRequestsProps { task: Task }
export interface MergeAheadMatrixProps { task: Task }
export interface ActivityFeedProps { agents: Live["agents"] }

export interface ContractFile {
  path: string;
  content: string;
}

/** Unified, read-only Git diff pinned to the commits used to generate it. */
export interface UnifiedCodeDiff {
  base: string;
  head: string;
  unified: string;
  /** Every path whose tree entry changed, including paths whose diff text was capped. */
  files: string[];
  /** Changed paths whose diff content was omitted by per-file or total output limits. */
  omitted: string[];
}

/** Dashboard's narrow code-view and human-waiver API surface. */
export interface CodeVisibilityApi {
  contractFiles(taskId: string): Promise<ContractFile[]>;
  sliceDiff(taskId: string, sliceId: string): Promise<UnifiedCodeDiff>;
  landingDiff(taskId: string): Promise<UnifiedCodeDiff>;
  waive(taskId: string, sliceId: string, reason: string): Promise<unknown>;
}

export interface CodeDecisionsProps {
  task: Task;
  busy: boolean;
  onWaive(sliceId: string, reason: string): void;
  onLand(): void;
  onContractFilesReady(taskId: string, ready: boolean): void;
}

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
