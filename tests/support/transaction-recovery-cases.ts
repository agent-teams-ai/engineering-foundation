import assert from "node:assert/strict";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  assertKnownFileTransactionEnvelope,
  canonicalJson,
  inspectKnownFileTransactionBarrier,
  installedRepositoryMutationBuildIdentity,
  installedRepositoryMutationVersion,
} from "../../packages/repository-mutation/dist/index.js";
import {
  applyKnownFileTransaction,
  recoverKnownFileTransaction,
} from "../../packages/repository-mutation/dist/qualification/index.js";
import { compileKnownFileTransactionEnvelope } from "../../packages/repository-mutation/dist/repository-mutation/application/policies/known-file-transaction-envelope.js";
import {
  fixture,
  killAtCheckpoint,
  plan,
  posixTest,
  replacementPlan,
} from "./known-file-transaction-node-fixtures.mjs";
import { assertKnownFileSchemaIdentity } from "./known-file-transaction-schema-fixtures.mjs";
import { assertManualOnly } from "./transaction-recovery-snapshot.ts";
export function registerRecoveryCases() {
  for (const state of ["APPLYING", "COMMITTED"]) {
    posixTest(
      `current ${state} create/replace recovery emits only current schema receipts`,
      async (context) => {
        const root = await fixture(context);
        await assert.rejects(
          applyKnownFileTransaction({
            consumerRoot: root,
            plan: plan(),
            faultInjector(point) {
              if (
                state === "APPLYING"
                  ? point.phase === "after-operation-published" && point.operationIndex === 1
                  : point.phase === "after-journal-committed"
              ) {
                throw new Error("schema-recovery-stop");
              }
            },
          }),
          /schema-recovery-stop/u,
        );
        const envelope = JSON.parse(
          await readFile(join(root, ".agent-teams-local", "scaffolding-transaction.json"), "utf8"),
        );
        assert.equal(envelope.schemaVersion, 6);
        assert.equal(envelope.format, "agent-teams.repository-mutation.transaction-envelope/v1");
        assert.equal(envelope.state, state);
        assertKnownFileTransactionEnvelope(envelope);
        await assertKnownFileSchemaIdentity("plan", envelope.payload.plan);
        const installed = {
          name: "@agent-teams/repository-mutation",
          version: await installedRepositoryMutationVersion(),
          buildIdentity: await installedRepositoryMutationBuildIdentity(),
        };
        assert.deepEqual(envelope.ownerArtifact, installed);
        assert.deepEqual(envelope.kernelArtifact, installed);
        const receipt = await recoverKnownFileTransaction({ consumerRoot: root });
        await assertKnownFileSchemaIdentity("receipt", receipt);
        assert.deepEqual(
          receipt.operations.map((operation) => operation.outcome),
          state === "APPLYING"
            ? ["rolled-back-to-preimage", "rolled-back-to-absent"]
            : ["replaced", "created"],
        );
        assert.equal(
          (await inspectKnownFileTransactionBarrier({ consumerRoot: root })).state,
          "idle",
        );
        await assert.rejects(
          readFile(join(root, ".agent-teams-local", "scaffolding-transaction.json")),
          /ENOENT/u,
        );
        const replay = await applyKnownFileTransaction({ consumerRoot: root, plan: plan() });
        await assertKnownFileSchemaIdentity("receipt", replay);
        assert.equal(replay.outcome, state === "APPLYING" ? "applied" : "already-satisfied");
      },
    );
  }

  registerRecoveryInterruptionCases();
}

function registerRecoveryInterruptionCases() {
  for (const [checkpoint, expectedOutcome] of [
    ["after-rollback-temporary-ready", "rolled-back"],
    ["after-preimage-captured", "rolled-back"],
    ["after-postimage-linked", "rolled-back"],
    ["after-committed-capture-unlinked", "applied"],
  ]) {
    posixTest(`SIGKILL recovery is exact at ${checkpoint}`, async (context) => {
      const root = await fixture(context);
      await killAtCheckpoint(root, checkpoint);
      const recovered = await recoverKnownFileTransaction({ consumerRoot: root });
      await assertKnownFileSchemaIdentity("receipt", recovered);
      assert.equal(recovered.outcome, expectedOutcome);
      assert.equal(
        await readFile(join(root, "managed", "existing.txt"), "utf8"),
        expectedOutcome === "applied" ? "new\n" : "old\n",
      );
      assert.equal((await stat(join(root, "managed", "existing.txt"))).nlink, 1);
      assert.equal(
        (await inspectKnownFileTransactionBarrier({ consumerRoot: root })).state,
        "idle",
      );
      const replay = { consumerRoot: root, plan: replacementPlan() };
      assert.equal(
        (await applyKnownFileTransaction(replay)).outcome,
        expectedOutcome === "applied" ? "already-satisfied" : "applied",
      );
      assert.equal((await applyKnownFileTransaction(replay)).outcome, "already-satisfied");
    });
  }
  registerRecoveryRollbackCases();
}
function registerRecoveryRollbackCases() {
  for (const [checkpoint, expectedContent, expectedOutcome] of [
    ["after-barrier-acquired", "old\n", "applied"],
    ["after-journal-retired", "new\n", "already-satisfied"],
  ]) {
    posixTest(
      `dead lock residue is safely taken over after SIGKILL at ${checkpoint}`,
      async (context) => {
        const root = await fixture(context);
        await killAtCheckpoint(root, checkpoint);
        assert.equal(
          await readFile(join(root, "managed", "existing.txt"), "utf8"),
          expectedContent,
        );
        const result = await applyKnownFileTransaction({
          consumerRoot: root,
          plan: replacementPlan(),
        });
        assert.equal(result.outcome, expectedOutcome);
        assert.equal(await readFile(join(root, "managed", "existing.txt"), "utf8"), "new\n");
        assert.equal(
          (await inspectKnownFileTransactionBarrier({ consumerRoot: root })).state,
          "idle",
        );
      },
    );
  }

  posixTest(
    "recovery preserves ordered provenance when recovery and release both fail",
    async (context) => {
      const root = await fixture(context);
      await assert.rejects(
        applyKnownFileTransaction({
          consumerRoot: root,
          plan: replacementPlan(),
          faultInjector(point) {
            if (point.phase === "after-operation-published") {
              throw new Error("apply crash");
            }
          },
        }),
        /apply crash/u,
      );
      const primaryFailure = new Error("recovery primary failure");
      await assert.rejects(
        recoverKnownFileTransaction({
          consumerRoot: root,
          async faultInjector(point) {
            if (point.phase !== "after-destination-retired") {
              return;
            }
            await writeFile(
              join(root, ".agent-teams-local", "foundation-operation.lock"),
              "invalid release evidence\n",
              "utf8",
            );
            throw primaryFailure;
          },
        }),
        (error) => {
          assert.ok(error instanceof AggregateError);
          assert.equal(
            error.message,
            "Known-file recovery and transaction lease release both failed.",
          );
          assert.equal(error.errors[0], primaryFailure);
          assert.equal(error.errors[1]?.code, "MUTATION_LEASE_INVALID");
          assert.equal(error.cause, primaryFailure);
          return true;
        },
      );
      assert.ok(await stat(join(root, ".agent-teams-local", "scaffolding-transaction.json")));
    },
  );

  posixTest("failed recovery release surfaces without pruning recovery state", async (context) => {
    const root = await fixture(context);
    await assert.rejects(
      applyKnownFileTransaction({
        consumerRoot: root,
        plan: replacementPlan(),
        faultInjector(point) {
          if (point.phase === "after-operation-published") {
            throw new Error("apply crash");
          }
        },
      }),
      /apply crash/u,
    );
    const state = join(root, ".agent-teams-local");
    await assert.rejects(
      recoverKnownFileTransaction({
        consumerRoot: root,
        async faultInjector(point) {
          if (point.phase === "after-rollback-linked") {
            await writeFile(
              join(state, "foundation-operation.lock"),
              "invalid release evidence\n",
              "utf8",
            );
          }
        },
      }),
      (error) =>
        error !== null &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "MUTATION_LEASE_INVALID",
    );
    assert.equal(await readFile(join(root, "managed", "existing.txt"), "utf8"), "old\n");
    await assert.rejects(
      stat(join(state, "scaffolding-transaction.json")),
      (error) =>
        error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT",
    );
    assert.equal(
      await readFile(join(state, "foundation-operation.lock"), "utf8"),
      "invalid release evidence\n",
    );
  });

  posixTest(
    "rollback verifies already-satisfied guards before returning a receipt",
    async (context) => {
      const root = await fixture(context);
      await writeFile(join(root, "managed", "new.txt"), "created\n", { mode: 0o644 });
      await assert.rejects(
        applyKnownFileTransaction({
          consumerRoot: root,
          plan: plan(),
          faultInjector(point) {
            if (point.phase === "after-operation-published" && point.operationIndex === 0) {
              throw new Error("apply-crash");
            }
          },
        }),
        /apply-crash/u,
      );
      await writeFile(join(root, "managed", "new.txt"), "guard-drift\n", { mode: 0o644 });
      await assert.rejects(
        recoverKnownFileTransaction({ consumerRoot: root }),
        (error) =>
          error !== null &&
          typeof error === "object" &&
          "code" in error &&
          error.code === "KNOWN_FILE_RECOVERY_CONFLICT",
      );
      assert.equal(await readFile(join(root, "managed", "existing.txt"), "utf8"), "old\n");
      assert.equal(await readFile(join(root, "managed", "new.txt"), "utf8"), "guard-drift\n");
    },
  );

  posixTest(
    "journal policy rejects created and authorized paths outside operation parents",
    async (context) => {
      const root = await fixture(context);
      await assert.rejects(
        applyKnownFileTransaction({
          consumerRoot: root,
          plan: replacementPlan(),
          faultInjector(point) {
            if (point.phase === "after-journal-created") {
              throw new Error("journal-crash");
            }
          },
        }),
        /journal-crash/u,
      );
      const envelope = JSON.parse(
        await readFile(join(root, ".agent-teams-local", "scaffolding-transaction.json"), "utf8"),
      );
      for (const journal of [
        {
          ...envelope.payload,
          createdDirectories: [
            {
              path: "../outside",
              identity: { birthtimeNs: "1", dev: "1", ino: "1" },
            },
          ],
        },
        { ...envelope.payload, authorizedDirectories: ["unrelated"] },
      ]) {
        assert.throws(
          () =>
            compileKnownFileTransactionEnvelope({
              ownerArtifact: envelope.ownerArtifact,
              kernelArtifact: envelope.kernelArtifact,
              journal,
              state: "APPLYING",
            }),
          /created directory|authorized-directory/u,
        );
      }
    },
  );

  for (const state of ["APPLYING", "COMMITTED"]) {
    for (const artifact of ["ownerArtifact", "kernelArtifact"]) {
      for (const [field, foreign] of [
        ["name", "@example/foreign-owner"],
        ["version", "99.0.0"],
        ["buildIdentity", `sha256:${"0".repeat(64)}`],
      ]) {
        posixTest(
          `${state} recovery refuses mismatched ${artifact}.${field} and preserves partial effects`,
          async (context) => {
            const root = await fixture(context);
            await assert.rejects(
              applyKnownFileTransaction({
                consumerRoot: root,
                plan: replacementPlan(),
                faultInjector(point) {
                  if (
                    point.phase ===
                    (state === "APPLYING" ? "after-operation-published" : "after-journal-committed")
                  ) {
                    throw new Error("apply-crash");
                  }
                },
              }),
              /apply-crash/u,
            );
            const journalPath = join(root, ".agent-teams-local", "scaffolding-transaction.json");
            const envelope = JSON.parse(await readFile(journalPath, "utf8"));
            await assertKnownFileSchemaIdentity("plan", envelope.payload.plan);
            const foreignBuild = compileKnownFileTransactionEnvelope({
              ownerArtifact: envelope.ownerArtifact,
              kernelArtifact: envelope.kernelArtifact,
              [artifact]: { ...envelope[artifact], [field]: foreign },
              journal: envelope.payload,
              state: envelope.state,
            });
            await writeFile(
              journalPath,
              `${canonicalJson(JSON.parse(JSON.stringify(foreignBuild)))}\n`,
              "utf8",
            );
            await assertManualOnly(root, /exact owner and kernel artifacts/u);
            assert.equal(await readFile(join(root, "managed", "existing.txt"), "utf8"), "new\n");
          },
        );
      }
    }
  }
}
