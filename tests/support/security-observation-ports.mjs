import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ContainedFileReadError } from "../../packages/engineering-foundation/dist/source-inventory/api.js";
import { readContainedRegularFile, pathTraversesSymbolicLink } from "../../packages/engineering-foundation/dist/source-inventory/node.js";
import { rejectSecurityFileReadFailure } from "../../packages/engineering-foundation/dist/capabilities/repository-security-baseline/application/policies/security-file-read-failure.js";
import { FilesystemRepositorySecurityReader } from "../../packages/engineering-foundation/dist/capabilities/repository-security-baseline/adapters/outbound/filesystem/filesystem-repository-security-reader.js";

export function registerSecurityObservationPortTests() {
  test("security observation failure policy preserves required/optional classification and unknown identity", () => {
    const codes = {
      escape: "REPOSITORY_SECURITY_EVIDENCE_ESCAPE",
      symlink: "REPOSITORY_SECURITY_SYMLINK_PROHIBITED",
      invalid: "REPOSITORY_SECURITY_EVIDENCE_INVALID",
      changed: "REPOSITORY_SECURITY_EVIDENCE_UNAVAILABLE",
      missing: "REPOSITORY_SECURITY_EVIDENCE_UNAVAILABLE",
      unavailable: "REPOSITORY_SECURITY_EVIDENCE_UNAVAILABLE",
    };
    for (const [failure, code] of Object.entries(codes)) {
      for (const optional of [false, true]) {
        const invoke = () => rejectSecurityFileReadFailure(new ContainedFileReadError(failure), "fixture.yml", optional);
        if (optional && failure === "missing") { assert.equal(invoke(), undefined); }
        else { assert.throws(invoke, (error) => error.problem.code === code); }
      }
    }
    for (const failure of [new Error("unknown"), { name: "ContainedFileReadError", failure: "missing" }, null, "unknown"]) {
      for (const optional of [false, true]) {
        assert.throws(() => rejectSecurityFileReadFailure(failure, "fixture.yml", optional), (error) => error === failure);
      }
    }
  });

  test("security feature threads the observation and parser ports without swallowing unknown failures", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "security-observation-port-")));
    try {
      await mkdir(join(root, "workflows"));
      await writeFile(join(root, "workflows", "ci.yml"), "on: pull_request\njobs: {}\n");
      const policy = { workflowDirectory: "workflows", publishablePackageManifests: [] };
      const calls = [], sentinel = { parser: "unknown failure" };
      const reader = new FilesystemRepositorySecurityReader({
        async read(input) { calls.push(["read", input]); return readContainedRegularFile(input); },
        async traversesSymbolicLink(...args) { calls.push(["traverse", ...args]); return pathTraversesSymbolicLink(...args); },
        parseYaml(...args) { calls.push(["parse", ...args]); throw sentinel; },
      });
      await assert.rejects(reader.read(root, policy), (error) => error === sentinel);
      assert.deepEqual(calls, [
        ["traverse", root, join(root, "workflows")],
        ["read", { candidate: join(root, "workflows", "ci.yml"), root, maxBytes: 4 * 1024 * 1024 }],
        ["parse", "on: pull_request\njobs: {}\n", "workflow:workflows/ci.yml"],
      ]);
      const controller = new AbortController(); controller.abort(); calls.length = 0;
      await assert.rejects(reader.read(root, policy, controller.signal), /cancel/iu);
      assert.deepEqual(calls, []);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}
