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
  if (slice.attention !== undefined) stage = "needs-human";
  else if (slice.status === "integrated") stage = "integrated";
  else if (slice.gate?.status === "running") stage = "gate";
  else if (slice.reviewHead) stage = "in-review";
  else stage = "building";

  return { stage, revisions: slice.revisions ?? 0 };
}

/** Build a matrix of the most recent merge-ahead check for every pair. */
export function buildMergeMatrix(task: Task): MergeMatrix {
  const ids = ["base", ...task.slices.map((slice) => slice.id)];
  const cells: MergeMatrixCell[][] = ids.map((row, rowIndex) =>
    ids.map((column, columnIndex) => {
      if (rowIndex === columnIndex) {
        return { row, column, status: "same", files: [] };
      }

      const newest = task.checks
        .filter(
          (check) =>
            (check.pair[0] === row && check.pair[1] === column) ||
            (check.pair[0] === column && check.pair[1] === row),
        )
        .reduce<(typeof task.checks)[number] | undefined>((latest, check) => {
          if (!latest || isNewer(check.checkedAt, latest.checkedAt)) return check;
          return latest;
        }, undefined);

      if (!newest) return { row, column, status: "unchecked", files: [] };
      return {
        row,
        column,
        status: newest.status,
        files: [...newest.files],
        checkedAt: newest.checkedAt,
      };
    }),
  );

  return { ids, cells };
}

/** Combine all agent logs into one newest-first activity stream. */
export function mergeActivity(agents: Live["agents"], includeCommands = false): ActivityItem[] {
  const events: ActivityItem[] = [];

  for (const agent of agents) {
    if (agent.builder) {
      agent.builder.log.forEach((entry, index) => {
        if (!includeCommands && entry.event.startsWith("run:")) return;
        events.push({
          id: `${agent.id}:builder:${index}`,
          sliceId: agent.id,
          agent: "builder",
          at: entry.at,
          event: entry.event,
        });
      });
    }

    agent.reviewers.forEach(({ role, state }, reviewerIndex) => {
      if (!state) return;
      state.log.forEach((entry, index) => {
        if (!includeCommands && entry.event.startsWith("run:")) return;
        events.push({
          id: `${agent.id}:${role}:${reviewerIndex}:${index}`,
          sliceId: agent.id,
          agent: role,
          at: entry.at,
          event: entry.event,
        });
      });
    });
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
