import assert from "node:assert/strict";
import { realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { withAgentWorkflowFixture as withUnmarkedAgentWorkflowFixture } from "../support/capability-fixtures.mjs";
import { ContainedFileReadError, inspectContainedRegularFile, readContainedRegularFile } from "../../packages/engineering-foundation/dist/source-inventory/node.js";
import { FilesystemEffectiveInstructionsReader } from "../../packages/engineering-foundation/dist/capabilities/repository-agent-workflow/adapters/outbound/filesystem/filesystem-effective-instructions-reader.js";
import { CapabilityInputError } from "../../packages/engineering-foundation/dist/features/validation-reporting/api.js";

const instructionObservation = { read: readContainedRegularFile, inspect: inspectContainedRegularFile };
const cancelled = (error) => error instanceof CapabilityInputError && error.problem.code === "EXECUTION_CANCELLED";
async function withAgentWorkflowFixture(callback) {
  return withUnmarkedAgentWorkflowFixture(async (root) => {
    await writeFile(join(root, "DISPOSABLE_SANDBOX"), "Instruction observation port test fixture.\n");
    return callback(await realpath(root));
  });
}


export function registerInstructionObservationPortCases() {
  test("instruction observation port selects only required bytes or metadata in candidate order", async () => {
    await withAgentWorkflowFixture(async (root) => {
      await writeFile(join(root, "AGENTS.override.md"), "override");
      const bytes = Uint8Array.from([0xff, 0x00, 0x0d, 0x0a]);
      const calls = [];
      const reader = new FilesystemEffectiveInstructionsReader({
        async read(input) { calls.push(["read", input]); return bytes; },
        async inspect(input) { calls.push(["inspect", input]); return { size: 73 }; }
      });
      const input = { consumerRoot: root, directory: ".", readSelectedBytes: true };
      const content = await reader.readDirectory(input);
      assert.deepEqual(content.candidates.map(({ path }) => path), ["AGENTS.override.md", "AGENTS.md"]);
      assert.equal(content.candidates[0].bytes, bytes);
      assert.equal(content.candidates[0].sourceBytes, 4);
      assert.equal(content.candidates[1].bytes, null);
      const metadata = await reader.readDirectory({ ...input, readSelectedBytes: false });
      assert.equal(metadata.candidates[0].sourceBytes, 73);
      assert.equal(metadata.candidates[0].bytes, null);
      assert.deepEqual(calls, [
        ["read", { candidate: join(root, "AGENTS.override.md"), root, maxBytes: 256 * 1024 }],
        ["inspect", { candidate: join(root, "AGENTS.override.md"), root }]
      ]);
    });
  });

  test("instruction observation failures preserve identity classification in both read modes", async () => {
    await withAgentWorkflowFixture(async (root) => {
      for (const readSelectedBytes of [true, false]) {
        const failures = ["missing", "invalid", "changed", "escape", "symlink", "unavailable"];
        const errors = failures.map((failure) => new ContainedFileReadError(failure));
        errors.push(Object.assign(new Error("opaque failure"), { name: "ContainedFileReadError", failure: "missing" }));
        for (const [index, failure] of errors.entries()) {
          const reader = new FilesystemEffectiveInstructionsReader({
            async read() { throw failure; },
            async inspect() { throw failure; }
          });
          await assert.rejects(reader.readDirectory({ consumerRoot: root, directory: ".", readSelectedBytes }), (error) => {
            assert.ok(error instanceof CapabilityInputError);
            assert.deepEqual(error.problem, {
              code: "REPOSITORY_AGENT_WORKFLOW_INSTRUCTION_UNAVAILABLE",
              message: readSelectedBytes
                ? `The instruction candidate must be a stable real file no larger than 262144 bytes: AGENTS.md (${failures[index] ?? "unavailable"}).`
                : `The instruction candidate must remain a stable real repository file: AGENTS.md (${failures[index] ?? "unavailable"}).`,
              phase: "repository-agent-workflow-effective-instructions",
              retryable: false
            });
            return true;
          });
        }
      }
    });
  });

  test("instruction observation cancellation and path validation retain precedence", async () => {
    await withAgentWorkflowFixture(async (root) => {
      for (const readSelectedBytes of [true, false]) {
        const controller = new AbortController();
        let observations = 0;
        const reader = new FilesystemEffectiveInstructionsReader({
          async read(input) { observations += 1; controller.abort(); return readContainedRegularFile(input); },
          async inspect(input) { observations += 1; controller.abort(); return inspectContainedRegularFile(input); }
        });
        const input = { consumerRoot: root, directory: ".", readSelectedBytes, signal: controller.signal };
        await assert.rejects(reader.readDirectory(input), cancelled);
        assert.equal(observations, 1);
        await assert.rejects(reader.readDirectory(input), cancelled);
        await assert.rejects(reader.discover({ consumerRoot: root, targetPath: "../invalid", signal: controller.signal }), cancelled);
        assert.equal(observations, 1);
      }
      const reader = new FilesystemEffectiveInstructionsReader(instructionObservation);
      await assert.rejects(reader.readDirectory({ consumerRoot: join(root, "unavailable"), directory: "../invalid", readSelectedBytes: true }), (error) => {
        assert.ok(error instanceof CapabilityInputError);
        assert.deepEqual(error.problem, {
          code: "CONFIG_PATH_INVALID",
          message: "Configuration paths must be normalized repository-relative POSIX paths.",
          phase: "repository-agent-workflow-effective-instructions",
          retryable: false
        });
        return true;
      });
    });
  });
}
