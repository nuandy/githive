import type { Live, Task } from "../api";
import type {
  ActivityItem,
  DashboardSliceStage,
  MergeMatrix,
  MergeMatrixCell,
  SliceStageInfo,
} from "../dashboard-contract";

/** Derive the most relevant visible state for a slice. */
export function getSliceStage(slice: Task["slices"][number]): SliceStageInfo {
  let stage: DashboardSliceStage;
  if (slice?.attention !== undefined) stage = "needs-human";
  else if (slice?.status === "integrated") stage = "integrated";
  else if (slice?.gate?.status === "running") stage = "gate";
  else if (slice?.reviewHead) stage = "in-review";
  else stage = "building";

  return { stage, revisions: slice?.revisions ?? 0 };
}

/** Build a matrix of the most recent merge-ahead check for every pair. */
export function buildMergeMatrix(task: Task): MergeMatrix {
  const slices = Array.isArray(task?.slices) ? task.slices : [];
  const checks = Array.isArray(task?.checks) ? task.checks : [];
  const ids = ["base", ...slices.map((slice) => slice.id)];
  const cells: MergeMatrixCell[][] = ids.map((row, rowIndex) =>
    ids.map((column, columnIndex) => {
      if (rowIndex === columnIndex) {
        return { row, column, status: "same", files: [] };
      }

      const newest = checks
        .filter(
          (check) => {
            const pair = check?.pair;
            return Array.isArray(pair) && pair.length >= 2 &&
              ((pair[0] === row && pair[1] === column) || (pair[0] === column && pair[1] === row));
          },
        )
        .reduce<(typeof checks)[number] | undefined>((latest, check) => {
          if (!latest || isNewer(check.checkedAt, latest.checkedAt)) return check;
          return latest;
        }, undefined);

      const integratedPair = slices.some(
        (slice) => slice.status === "integrated" && (slice.id === row || slice.id === column),
      );

      if (!newest) return { row, column, status: integratedPair ? "integrated" : "unchecked", files: [] };
      return {
        row,
        column,
        status: integratedPair ? "integrated" : newest.status,
        files: Array.isArray(newest.files) ? [...newest.files] : [],
        checkedAt: newest.checkedAt,
      };
    }),
  );

  return { ids, cells };
}

/** Combine all agent logs into one newest-first activity stream. */
export function mergeActivity(agents: Live["agents"], includeCommands = false): ActivityItem[] {
  const events: ActivityItem[] = [];

  for (const agent of Array.isArray(agents) ? agents : []) {
    if (!agent) continue;
    if (agent.builder) {
      (Array.isArray(agent.builder.log) ? agent.builder.log : []).forEach((entry, index) => {
        if (!entry || typeof entry.event !== "string") return;
        if (!includeCommands && entry.event.startsWith("run:")) return;
        events.push({
          id: `${agent.id}:builder:${index}`,
          sliceId: agent.id,
          agent: "builder",
          at: typeof entry.at === "string" ? entry.at : "",
          event: entry.event,
        });
      });
    }

    for (const [reviewerIndex, reviewer] of (Array.isArray(agent.reviewers) ? agent.reviewers : []).entries()) {
      const { role, state } = reviewer ?? {};
      if (!state) continue;
      (Array.isArray(state.log) ? state.log : []).forEach((entry, index) => {
        if (!entry || typeof entry.event !== "string") return;
        if (!includeCommands && entry.event.startsWith("run:")) return;
        events.push({
          id: `${agent.id}:${role}:${reviewerIndex}:${index}`,
          sliceId: agent.id,
          agent: role ?? "reviewer",
          at: typeof entry.at === "string" ? entry.at : "",
          event: entry.event,
        });
      });
    }
  }

  return events.sort((a, b) => compareNewest(a.at, b.at));
}

/** Return a sorted copy of the task list, newest creation first. */
export function newestTasks(tasks: Task[]): Task[] {
  return [...tasks].sort((a, b) => compareNewest(a.createdAt, b.createdAt));
}

function isNewer(candidate: string, current: string): boolean {
  return compareNewest(candidate, current) < 0;
}

/** Negative means `a` is more recent; stable sorting preserves ties. */
function compareNewest(a: string, b: string): number {
  const aTime = Date.parse(a);
  const bTime = Date.parse(b);
  if (Number.isFinite(aTime) && Number.isFinite(bTime)) return bTime - aTime;
  if (a === b) return 0;
  return a > b ? -1 : 1;
}
