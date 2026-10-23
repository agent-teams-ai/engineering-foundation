import assert from "node:assert/strict";

type JsonObject = Record<string, unknown>;
export function object(value: unknown): JsonObject {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as JsonObject;
}
export function text(value: unknown): string {
  assert.ok(typeof value === "string");
  return value;
}
function number(value: unknown): number {
  assert.ok(typeof value === "number" && Number.isSafeInteger(value));
  return value;
}
export function stageRecord(value: unknown) {
  const entry = object(value);
  const dist = object(entry.dist);
  assert.ok(typeof entry.stub === "boolean");
  return {
    ...entry,
    name: text(entry.name),
    version: text(entry.version),
    stub: entry.stub,
    ["_id"]: text(entry["_id"]),
    dist: { ...dist, tarball: text(dist.tarball), integrity: text(dist.integrity) },
  };
}
export function recoveryProfile(value: unknown) {
  const p = object(value);
  const approval = object(p.approval);
  const recovery = object(p.recovery);
  const placeholder = object(p.providerPlaceholder);
  const provenance = object(p.provenance);
  assert.ok(p.releasePredecessor === null);
  return {
    ...p,
    id: text(p.id),
    name: text(p.name),
    bootstrapVersion: text(p.bootstrapVersion),
    state: text(p.state),
    releasePredecessor: p.releasePredecessor,
    provenance: { ref: text(provenance.ref), workflowPath: text(provenance.workflowPath) },
    approval: {
      archiveIntegrity: text(approval.archiveIntegrity),
      packageTree: text(approval.packageTree),
    },
    recovery: {
      sourceCommit: text(recovery.sourceCommit),
      runId: number(recovery.runId),
      runAttempt: number(recovery.runAttempt),
    },
    providerPlaceholder: {
      version: text(placeholder.version),
      archiveIntegrity: text(placeholder.archiveIntegrity),
    },
  };
}
type WorkflowStep = { id?: string; name?: string; run?: string; if?: string };
export function workflowRecord(value: unknown): {
  jobs: Record<string, { steps: WorkflowStep[] }>;
} {
  const jobs = object(object(value).jobs);
  return {
    jobs: Object.fromEntries(
      Object.entries(jobs).map(([name, job]) => {
        const steps: unknown = object(job).steps;
        assert.ok(Array.isArray(steps));
        return [
          name,
          {
            steps: steps.map((rawStep: unknown) => {
              const row = object(rawStep);
              const result: WorkflowStep = {};
              for (const key of ["id", "name", "run", "if"] as const) {
                if (row[key] !== undefined) {
                  result[key] = text(row[key]);
                }
              }
              return result;
            }),
          },
        ];
      }),
    ),
  };
}
export function step(steps: WorkflowStep[], id: string): WorkflowStep {
  const selected = steps.find((s) => s.id === id);
  assert.ok(selected);
  return selected;
}

export function assertOrdered(source: string, values: readonly string[]): void {
  let offset = 0;
  for (const value of values) {
    const index = source.indexOf(value, offset);
    assert.notEqual(index, -1, `Missing ordered workflow evidence: ${value}`);
    offset = index + value.length;
  }
}
