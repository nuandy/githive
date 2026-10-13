import { defineConfig, mergeConfig } from "vitest/config";
import base, { SHARED_EXCLUDES, SOAK } from "./vitest.config";

// The soak runs (npm run test:soak): a demo's whole life under a failing store, a minute or more each. They run apart
// from the suite and one file at a time, since beside other tests their load slows those into their timeouts.
const soak = defineConfig({ test: { include: [SOAK.replace("**", "**/*.test.ts")], fileParallelism: false } });
export default mergeConfig({ ...base, test: { ...base.test, exclude: SHARED_EXCLUDES } }, soak);
