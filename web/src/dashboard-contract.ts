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
