import { performance } from "node:perf_hooks";

import type { MonotonicClock } from "../../../application/ports/monotonic-clock.js";

export const performanceMonotonicClock: MonotonicClock = Object.freeze({
  nowMs: () => performance.now()
});
