import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { CapabilityInputError } from "../../packages/engineering-foundation/dist/features/validation-reporting/api.js";
import { FilesystemArchitectureDecisionBaselineRepository } from "../../packages/engineering-foundation/dist/capabilities/governance-architecture-decisions/adapters/outbound/filesystem/filesystem-architecture-decision-baseline-repository.js";
import { ContainedFileReadError, pathTraversesSymbolicLink, readContainedRegularFile } from "../../packages/engineering-foundation/dist/source-inventory/node.js";

const baselineObservation = { read: readContainedRegularFile, pathTraversesSymbolicLink };
const fixtureRoot = fileURLToPath(new URL("../fixtures/governance-architecture-decisions/valid", import.meta.url));
async function withFixture(callback) {
  const root = await mkdtemp(join(tmpdir(), "foundation-baseline-observation-test-"));
  try {
    await cp(fixtureRoot, root, { recursive: true });
    await writeFile(join(root, "DISPOSABLE_SANDBOX"), "Baseline observation port test fixture.\n");
    return await callback(root);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}
function baselinePath(root) {
  return join(root, "architecture/decisions/accepted-decisions.json");
}
function hasProblemCode(error, code) {
  return error instanceof CapabilityInputError && error.problem.code === code;
}
function baselineWithDigest(baseline, character) {
  const value = structuredClone(baseline);
  value.decisions[0].immutableDigest = `sha256:${character.repeat(64)}`;
  return value;
}


export function registerBaselineObservationPortCases() {
  test("baseline observation port preserves bounds, error identity and failure mapping", async () => {
    await withFixture(async (root) => {
      const input = { consumerRoot: root, path: "architecture/decisions/accepted-decisions.json" };
      for (const failure of ["missing", "invalid", "changed", "escape", "symlink", "unavailable"]) {
        const repository = new FilesystemArchitectureDecisionBaselineRepository({
          pathTraversesSymbolicLink,
          async read(location) {
            assert.deepEqual(location, { root, candidate: baselinePath(root), maxBytes: 4 * 1024 * 1024 });
            throw new ContainedFileReadError(failure);
          }
        });
        const result = await repository.read(input);
        assert.deepEqual(result, failure === "missing" ? { kind: "missing" } : failure === "invalid"
          ? { kind: "invalid", message: "Accepted-decision baseline must be a regular JSON file no larger than 4194304 bytes." }
          : { kind: "unsafe", message: "Accepted-decision baseline is unavailable, unsafe, or changed while reading." });
      }
      const impostor = Object.assign(new Error("opaque failure"), { name: "ContainedFileReadError", failure: "missing" });
      const repository = new FilesystemArchitectureDecisionBaselineRepository({
        pathTraversesSymbolicLink,
        async read() { throw impostor; }
      });
      await assert.rejects(repository.read(input), (error) => error === impostor);
    });
  });

  test("baseline observation cancellation retains bytes and concrete cancellation identity", async () => {
    await withFixture(async (root) => {
      const before = await readFile(baselinePath(root));
      const controller = new AbortController();
      let reads = 0;
      const repository = new FilesystemArchitectureDecisionBaselineRepository({
        pathTraversesSymbolicLink,
        async read(input) {
          reads += 1;
          const bytes = await readContainedRegularFile(input);
          controller.abort();
          return bytes;
        }
      });
      const input = { consumerRoot: root, path: "architecture/decisions/accepted-decisions.json", signal: controller.signal };
      await assert.rejects(repository.read(input), (error) => hasProblemCode(error, "EXECUTION_CANCELLED"));
      assert.equal(reads, 1);
      await assert.rejects(repository.read(input), (error) => hasProblemCode(error, "EXECUTION_CANCELLED"));
      await assert.rejects(repository.write({ ...input, baseline: JSON.parse(before), expected: { kind: "missing" } }),
        (error) => hasProblemCode(error, "EXECUTION_CANCELLED"));
      assert.equal(reads, 1);
      assert.deepEqual(await readFile(baselinePath(root)), before);
    });
  });

  test("baseline final observation detects a racing writer and cleans up for retry", async () => {
    await withFixture(async (root) => {
      const ordinary = new FilesystemArchitectureDecisionBaselineRepository(baselineObservation);
      const input = { consumerRoot: root, path: "architecture/decisions/accepted-decisions.json" };
      const current = await ordinary.read(input);
      assert.equal(current.kind, "valid");
      const externalBytes = `${JSON.stringify(baselineWithDigest(current.value, "b"))}\n`;
      const baseline = baselineWithDigest(current.value, "a");
      let reads = 0;
      const repository = new FilesystemArchitectureDecisionBaselineRepository({
        pathTraversesSymbolicLink,
        async read(location) {
          reads += 1;
          if (reads === 3) {
            const temporary = (await readdir(dirname(location.candidate)))
              .filter((name) => name.startsWith(".architecture-decision-baseline-"));
            assert.equal(temporary.length, 1);
            assert.deepEqual(JSON.parse(await readFile(join(dirname(location.candidate), temporary[0], "baseline.json"))), baseline);
            await writeFile(location.candidate, externalBytes);
          }
          return readContainedRegularFile(location);
        }
      });
      await assert.rejects(repository.write({ ...input, baseline, expected: { kind: "valid", revision: current.revision } }),
        (error) => hasProblemCode(error, "ARCHITECTURE_DECISION_BASELINE_WRITE_CONFLICT"));
      assert.equal(reads, 3);
      assert.equal(await readFile(baselinePath(root), "utf8"), externalBytes);
      assert.deepEqual((await readdir(dirname(baselinePath(root)))).filter((name) => name.startsWith(".architecture-decision-baseline-") || name.endsWith(".lock")), []);
      const fresh = await ordinary.read(input);
      assert.equal(await ordinary.write({ ...input, baseline, expected: { kind: "valid", revision: fresh.revision } }), "updated");
    });
  });

  test("baseline final symlink observation rejects replacement after the last read", { skip: process.platform === "win32" }, async () => {
    await withFixture(async (root) => {
      const input = { consumerRoot: root, path: "architecture/decisions/accepted-decisions.json" };
      const current = await new FilesystemArchitectureDecisionBaselineRepository(baselineObservation).read(input);
      const bytes = await readFile(baselinePath(root));
      const target = join(root, "retained-baseline.json");
      await writeFile(target, bytes);
      let reads = 0;
      const repository = new FilesystemArchitectureDecisionBaselineRepository({
        pathTraversesSymbolicLink,
        async read(location) {
          const observed = await readContainedRegularFile(location);
          reads += 1;
          if (reads === 3) {
            await rm(location.candidate);
            await symlink(target, location.candidate);
          }
          return observed;
        }
      });
      await assert.rejects(repository.write({ ...input, baseline: baselineWithDigest(current.value, "a"), expected: { kind: "valid", revision: current.revision } }),
        (error) => hasProblemCode(error, "ARCHITECTURE_DECISION_BASELINE_WRITE_SYMLINK_PROHIBITED"));
      assert.equal(reads, 3);
      assert.deepEqual(await readFile(target), bytes);
      assert.deepEqual((await readdir(dirname(baselinePath(root)))).filter((name) => name.startsWith(".architecture-decision-baseline-") || name.endsWith(".lock")), []);
    });
  });
}
