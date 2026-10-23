import { createMatrixObservationFixture } from "./public-api-growth-observer-fixture.ts";
function isConditionTarget(
  value: GrowthExportTarget,
): value is { readonly [key: string]: GrowthExportTarget } {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function conditionTarget(value: GrowthExportTarget) {
  assert.ok(isConditionTarget(value));
  return value;
}
import {
  readGrowthSurfaceMatrix,
  growthTypedEntries,
  available,
  required,
} from "./public-api-growth-matrix-fixture.ts";
import type { MatrixRepository } from "./public-api-growth-matrix-fixture.ts";
import type {
  GrowthInvocation,
  GrowthCoverage,
  GrowthSurfaceObservation,
} from "../packages/engineering-foundation/dist/capabilities/public-api-compatibility/application/model/growth-observation.js";
import type { GrowthExportTarget } from "../packages/engineering-foundation/dist/capabilities/public-api-compatibility/application/model/growth-workspace.js";
import assert from "node:assert/strict";
import test from "node:test";
import { GrowthObservationUnavailableError } from "../packages/engineering-foundation/dist/capabilities/public-api-compatibility/application/model/growth-observation.js";
// Focused S1 observation cases; retained under the existing public API test owner.
{
  const { createHash } = await import("node:crypto");

  const { growthObservationDigest } =
    await import("../packages/engineering-foundation/dist/capabilities/public-api-compatibility/application/policies/normalize-growth-observation.js");
  const matrix = readGrowthSurfaceMatrix();
  const digest: `sha256:${string}` = `sha256:${"a".repeat(64)}`;
  const invocation: GrowthInvocation = {
    repository: "fixture",
    sourceCommit: "a".repeat(40),
    sourceTree: "b".repeat(40),
    topologyDigest: digest,
    lockDigest: digest,
    toolchainDigest: digest,
    artifactDigests: [digest],
    tool: { version: "1", artifactDigest: digest, extractorVersion: "pinned" },
  };
  const cancellation = { throwIfCancelled() {} };
  const fingerprint = {
    sha256(value: string) {
      return createHash("sha256").update(value).digest("hex");
    },
  };
  const fixture = (repository: MatrixRepository) =>
    createMatrixObservationFixture(repository, fingerprint, digest);
  for (const stage of ["workspace", "typed", "artifact"] as const) {
    void test(`S1: cancellation rejects running ${stage} observation without manual release`, async () => {
      const setup = fixture(matrix.repositories[1]);
      const controller = new AbortController();
      const cancelled = new Error("invocation cancelled");
      const started = Promise.withResolvers<AbortSignal | undefined>();
      const calls: string[] = [];
      let dependencyRejected = false;
      const read = setup.dependencies.workspace.read.bind(setup.dependencies.workspace);
      const extract = setup.dependencies.typed.extract.bind(setup.dependencies.typed);
      const inspect = setup.dependencies.artifact.inspect.bind(setup.dependencies.artifact);
      setup.dependencies.workspace.read = (...args) => {
        calls.push("workspace");
        return read(...args);
      };
      setup.dependencies.typed.extract = (...args) => {
        calls.push("typed");
        return extract(...args);
      };
      setup.dependencies.artifact.inspect = (...args) => {
        calls.push("artifact");
        return inspect(...args);
      };
      const block = (signal: AbortSignal | undefined): Promise<never> => {
        calls.push(stage);
        return new Promise((_resolve, reject) => {
          signal?.addEventListener(
            "abort",
            () => {
              dependencyRejected = true;
              reject(new Error("observer aborted"));
            },
            { once: true },
          );
          started.resolve(signal);
        });
      };
      if (stage === "workspace") {
        setup.dependencies.workspace.read = (...args) => block(args[2]);
      } else if (stage === "typed") {
        setup.dependencies.typed.extract = (...args) => block(args[3]);
      } else {
        setup.dependencies.artifact.inspect = (...args) => block(args[2]);
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error("running observer did not cancel"));
        }, 1000);
      });
      try {
        const execution = setup.port().observe(invocation, {
          signal: controller.signal,
          throwIfCancelled() {
            controller.signal.throwIfAborted();
          },
        });
        const rejected = assert.rejects(
          Promise.race([execution, deadline]),
          (error) => error === cancelled,
        );
        const received = await started.promise;
        controller.abort(cancelled);
        await rejected;
        assert.equal(received, controller.signal);
        assert.equal(dependencyRejected, true);
        assert.deepEqual(
          calls,
          ["workspace", "typed", "artifact"].slice(
            0,
            ["workspace", "typed", "artifact"].indexOf(stage) + 1,
          ),
        );
      } finally {
        clearTimeout(timer);
      }
    });
  }
  for (const repository of matrix.repositories) {
    void test(`S1: C0 ${repository.repository}: every frozen surface row has an existing route or explicit unsupported outcome`, async () => {
      const setup = fixture(repository);
      const result = await setup.port().observe(invocation, cancellation);
      assert.equal(setup.calls.workspace, 1);
      assert.equal(new Set(setup.calls.typed).size, setup.subjects.length);
      assert.equal(setup.calls.typed.length, setup.subjects.length);
      assert.equal(setup.calls.artifact.length, setup.subjects.length);
      assert.equal(result.surface.status, "available");
      assert.equal(result.compatibilitySnapshots.length, repository.packages.length);
      for (const pkg of repository.packages) {
        const coverage: GrowthCoverage = required(
          available(result.surface).coverage.find((row) => row.packageName === pkg.packageName),
        );
        assert.equal(coverage.dimensions.length, 10);
        assert.equal(
          required(coverage.dimensions.find((row) => row.dimension === "decision")).status,
          "unavailable",
        );
        for (const row of pkg.surface) {
          const entries: GrowthSurfaceObservation["entries"] = available(
            result.surface,
          ).entries.filter((entry) => entry.coordinate.packageName === pkg.packageName);
          if (row.shape.startsWith("typed-")) {
            assert.equal(
              entries.filter(
                (entry) =>
                  entry.coordinate.exportPath === row.exportPath &&
                  entry.coordinate.subject.kind === "typed",
              ).length,
              1,
            );
            assert.equal(
              entries.filter(
                (entry) =>
                  entry.coordinate.exportPath === row.exportPath &&
                  entry.coordinate.subject.kind === "export-branch",
              ).length,
              1,
            );
          } else if (row.shape === "wildcard") {
            assert.equal(
              entries.filter(
                (entry) =>
                  entry.coordinate.exportPath ===
                    required(row.exportPath).replaceAll("*", "fixture.schema.json") &&
                  entry.coordinate.subject.kind === "wildcard-member",
              ).length,
              1,
            );
          } else {
            const dimension = row.shape === "no-exports" ? "resolution" : row.shape;
            assert.equal(
              required(coverage.dimensions.find((entry) => entry.dimension === dimension)).status,
              "unsupported",
            );
          }
        }
      }
      assert.equal(Object.isFrozen(result), true);
      assert.equal(Object.isFrozen(available(result.surface).entries), true);
    });
  }
  void test("S1: reordered inventory and selectors have identical growth hashes", async () => {
    const setup = fixture(matrix.repositories[0]);
    const first = await setup.port().observe(invocation, cancellation);
    setup.packages.reverse();
    setup.subjects.reverse();
    const second = await setup.port().observe(invocation, cancellation);
    assert.equal(
      growthObservationDigest(available(first.surface), fingerprint),
      growthObservationDigest(available(second.surface), fingerprint),
    );
  });
  void test("S1: low-level observers cannot mutate the captured workspace observation", async () => {
    const setup = fixture(matrix.repositories[1]);
    const pkg = required(setup.packages.find((row) => row.exportSurface.explicit));
    const originalTarget = structuredClone(pkg.exportSurface.entries[0].target);
    const extract = setup.dependencies.typed.extract.bind(setup.dependencies.typed);
    setup.dependencies.typed.extract = async (...args) => {
      pkg.exportSurface.entries[0].target = null;
      return extract(...args);
    };
    const result = await setup.port().observe(invocation, cancellation);
    const typed = available(result.surface).entries.filter(
      (row) => row.coordinate.packageName === pkg.name && row.coordinate.subject.kind === "typed",
    );
    assert.equal(typed.length, 1);
    assert.deepEqual(typed[0].coordinate.resolutionBranch, [
      { condition: "import" },
      { condition: "types" },
    ]);
    assert.notEqual(originalTarget, null);
  });
  void test("S1: missing topology and failed observers never fabricate empty successful evidence", async () => {
    const setup = fixture(matrix.repositories[1]);
    setup.dependencies.workspace.read = async () => {
      throw new GrowthObservationUnavailableError("workspace unavailable");
    };
    const missing = await setup.port().observe(invocation, cancellation);
    assert.deepEqual(missing.surface, {
      status: "unavailable",
      reasons: ["workspace-observation-unavailable"],
    });
    assert.equal(setup.calls.typed.length, 0);
    setup.dependencies.workspace.read = async () => ({ packages: setup.packages, catalogs: [] });
    setup.dependencies.typed.extract = async () => {
      throw new Error("unavailable");
    };
    const failed = await setup.port().observe(invocation, cancellation);
    assert.equal(
      required(
        failed.compatibilitySnapshots.find(
          (row) => row.packageName === setup.subjects[0].policy.packageName,
        ),
      ).typed.snapshot.status,
      "unavailable",
    );
    assert.equal(
      available(failed.surface).entries.some((row) => row.coordinate.subject.kind === "typed"),
      false,
    );
  });
  void test("S1: unexpected workspace failures preserve identity instead of becoming unavailable evidence", async () => {
    const setup = fixture(matrix.repositories[1]);
    const failure = new TypeError("unexpected workspace implementation defect");
    setup.dependencies.workspace.read = async () => {
      throw failure;
    };
    await assert.rejects(
      setup.port().observe(invocation, cancellation),
      (error) => error === failure,
    );
    assert.equal(setup.calls.typed.length, 0);
  });
  void test("S1: duplicate topology, out-of-scope policy and forged observer package fail closed", async () => {
    const setup = fixture(matrix.repositories[1]);
    setup.packages.push(setup.packages[0]);
    await assert.rejects(
      setup.port().observe(invocation, cancellation),
      /duplicate-growth-collection-key/u,
    );
    setup.packages.pop();
    setup.subjects[0].policy.manifestPath = "elsewhere.json";
    await assert.rejects(
      setup.port().observe(invocation, cancellation),
      /growth-policy-outside-observed-topology/u,
    );
    const clean = fixture(matrix.repositories[1]);
    clean.dependencies.typed.extract = async () => ({
      schemaVersion: 1,
      packageName: "forged",
      packageVersion: "0.2.0",
      extractorVersion: "pinned",
      entrypoints: [],
    });
    await assert.rejects(
      clean.port().observe(invocation, cancellation),
      /typed-observer-provenance-mismatch/u,
    );
  });
  void test("S1: condition order, null and fallback mutations change growth values without inventing absence", async () => {
    const setup = fixture(matrix.repositories[1]);
    const pkg = required(setup.packages.find((row) => row.exportSurface.explicit));
    const entry = pkg.exportSurface.entries[0];
    const original = entry.target;
    assert.ok(original !== undefined);
    const before = await setup.port().observe(invocation, cancellation);
    entry.target = Object.fromEntries(Object.entries(conditionTarget(original)).toReversed());
    const reordered = await setup.port().observe(invocation, cancellation);
    assert.notEqual(
      growthObservationDigest(available(before.surface), fingerprint),
      growthObservationDigest(available(reordered.surface), fingerprint),
    );
    entry.target = [original, null, original];
    const fallback = await setup.port().observe(invocation, cancellation);
    const typedEntries = available(fallback.surface).entries.filter(
      (row) => row.coordinate.packageName === pkg.name && row.coordinate.subject.kind === "typed",
    );
    assert.equal(typedEntries.length, 2);
    assert.deepEqual(
      typedEntries.map((row) => row.coordinate.resolutionBranch[0]),
      [{ index: 0 }, { index: 2 }],
    );
    assert.equal(
      available(fallback.surface).entries.every((row) => row.value.state === "present"),
      true,
    );
  });
  void test("S1: config removal keeps the workspace package and unavailable branches", async () => {
    const setup = fixture(matrix.repositories[1]);
    const removed = required(setup.subjects.pop());
    const result = await setup.port().observe(invocation, cancellation);
    const row = required(
      result.compatibilitySnapshots.find(
        (entry) => entry.packageName === removed.policy.packageName,
      ),
    );
    assert.equal(row.typed.snapshot.status, "unavailable");
    assert.equal(row.artifact.snapshot.status, "unavailable");
    assert.ok(
      available(result.surface).coverage.some(
        (entry) => entry.packageName === removed.policy.packageName,
      ),
    );
  });
  void test("S1: unsupported typed wildcard retains an explicit outcome and no typed coordinates", async () => {
    const setup = fixture(matrix.repositories[1]);
    const pkg = required(setup.packages.find((row) => row.exportSurface.explicit));
    pkg.exportSurface.entries[0].target = { types: "./dist/*.d.ts", import: "./dist/*.js" };
    const result = await setup.port().observe(invocation, cancellation);
    assert.equal(
      required(
        required(
          available(result.surface).coverage.find((row) => row.packageName === pkg.name),
        ).dimensions.find((row) => row.dimension === "typed"),
      ).status,
      "unsupported",
    );
    assert.equal(
      available(result.surface).entries.some(
        (row) => row.coordinate.packageName === pkg.name && row.coordinate.subject.kind === "typed",
      ),
      false,
    );
  });
  void test("S1: uncanonical observed declarations keep v1 bytes but make growth unavailable", async () => {
    const setup = fixture(matrix.repositories[1]);
    const extract = setup.dependencies.typed.extract.bind(setup.dependencies.typed);
    setup.dependencies.typed.extract = async (...args) => {
      const value = await extract(...args);
      value.entrypoints[0].items[0].signature = "e\u0301";
      return value;
    };
    const result = await setup.port().observe(invocation, cancellation);
    assert.deepEqual(result.surface, {
      status: "unavailable",
      reasons: ["growth-canonical-value-unsupported"],
    });
    assert.equal(
      available(
        required(
          result.compatibilitySnapshots.find((row) => row.typed.snapshot.status === "available"),
        ).typed.snapshot,
      ).entrypoints[0].items[0].signature,
      "e\u0301",
    );
  });
  void test("S1: artifact-only identity changes do not manufacture SDK coordinates or values", async () => {
    const setup = fixture(matrix.repositories[1]);
    const before = await setup.port().observe(invocation, cancellation);
    const after = await setup
      .port()
      .observe({ ...invocation, artifactDigests: [`sha256:${"b".repeat(64)}`] }, cancellation);
    assert.deepEqual(available(before.surface).entries, available(after.surface).entries);
    assert.notEqual(
      growthObservationDigest(available(before.surface), fingerprint),
      growthObservationDigest(available(after.surface), fingerprint),
    );
  });
  void test("S1: equal-count replacement and signature mutations preserve opaque coordinate semantics", async () => {
    const setup = fixture(matrix.repositories[1]);
    const before = await setup.port().observe(invocation, cancellation);
    const extract = setup.dependencies.typed.extract.bind(setup.dependencies.typed);
    setup.dependencies.typed.extract = async (...args) => {
      const value = await extract(...args);
      value.entrypoints[0].items[0].canonicalReference = "opaque!replacement";
      return value;
    };
    const replaced = await setup.port().observe(invocation, cancellation);
    assert.equal(growthTypedEntries(before).length, growthTypedEntries(replaced).length);
    assert.notDeepEqual(
      growthTypedEntries(before).map((row) => row.coordinate),
      growthTypedEntries(replaced).map((row) => row.coordinate),
    );
    setup.dependencies.typed.extract = async (...args) => {
      const value = await extract(...args);
      value.entrypoints[0].items[0].signature = "export type Changed = number;";
      return value;
    };
    const changed = await setup.port().observe(invocation, cancellation);
    assert.deepEqual(
      growthTypedEntries(before).map((row) => row.coordinate),
      growthTypedEntries(changed).map((row) => row.coordinate),
    );
    assert.notDeepEqual(
      growthTypedEntries(before).map((row) => row.value),
      growthTypedEntries(changed).map((row) => row.value),
    );
  });
}
