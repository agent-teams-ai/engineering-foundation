import {
  type QualityCoverageObservation,
  type QualityCoverageReader,
  type QualityToolProvider,
  type QualityToolSession,
} from "../../../packages/engineering-foundation/dist/features/quality-coverage/api.js";

import { qualitySessionFixture } from "./quality-session-fixture.ts";

export const path = "packages/contexts/private-worker/src/main.ts";
export const invocation = {
  consumerRoot: "/disposable consumer",
  configPath: "quality.yaml",
  scopeOnly: false,
};
type Mutable<T> = {
  -readonly [K in keyof T]: T[K] extends readonly (infer Item)[]
    ? Mutable<Item>[]
    : T[K] extends object
      ? Mutable<T[K]>
      : T[K];
};
export const good: Mutable<QualityCoverageObservation> = {
  testPaths: [],
  sources: [{ path, owners: ["private-worker.application"], suppressionCovered: true }],
  requiredSettings: ["typeAware"],
  requiredSettingObservations: [
    {
      observationId: "lint.json#0",
      path: "lint.json",
      name: "typeAware",
      expected: "true",
      comparison: "equal" as const,
    },
  ],
  settings: [
    {
      observationId: "lint.json#0",
      path: "lint.json",
      name: "typeAware",
      expected: "true",
      actual: "true",
      comparison: "equal" as const,
    },
  ],
  requiredRoutes: [
    { entry: "check", mode: "full" as const },
    { entry: "check:fast", mode: "scope" as const },
  ],
  routes: [
    { entry: "check", mode: "full" as const, reached: true },
    { entry: "check:fast", mode: "scope" as const, reached: true },
  ],
};
export const reader = (observation: QualityCoverageObservation = good): QualityCoverageReader => ({
  read: async () => qualitySessionFixture(observation),
});
export function tool(overrides: Partial<QualityToolSession> = {}) {
  const calls: string[] = [];
  const provider: QualityToolProvider = {
    prepare: async () => {
      calls.push("prepare");
      return {
        select: async () => {
          calls.push("select");
          return [path];
        },
        typeContext: async () => {
          calls.push("context");
          return [path];
        },
        explicitUnknown: async () => {
          calls.push("scan");
          return [];
        },
        lint: async () => {
          calls.push("lint");
          return { files: 1, diagnostics: [] };
        },
        ...overrides,
      };
    },
  };
  return { calls, provider };
}
