import type { QualityGatePolicyInput } from "../model/quality-gate.js";

export type QualityGatePolicyLoader = (
  consumerRoot: string,
  configPath: string,
  signal?: AbortSignal,
) => Promise<QualityGatePolicyInput>;
