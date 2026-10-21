import { githive } from "../../src/githive";

// GitHive as a Worker with a dashboard builds it, reading the dashboard's files from the env's ASSETS.
export const withDashboard = githive({ dashboard: (env) => (env as unknown as { ASSETS: Fetcher }).ASSETS });
