import type { QualityGatePolicy } from "../model/quality-gate.js";

export type QualityGatePolicyLoader = (
  consumerRoot: string,
  configPath: string,
  signal?: AbortSignal
) => Promise<QualityGatePolicy>;

