import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  chmod, cp, mkdir, mkdtemp, readFile, readdir,
  rename, rm, stat, utimes, writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  applyFilesystemScaffold, assertScaffoldPlanDigest, assertScaffoldReceiptDigest,
  planScaffoldFromFile, recoverFilesystemScaffold, validateScaffoldReceipt,
} from "../packages/engineering-foundation/dist/scaffolding/index.js";
import { sha256Json } from "../packages/engineering-foundation/dist/scaffolding/kernel/canonical-json.js";
import { applyAuthorityFilesystemScaffoldWithFaultInjection } from "../packages/engineering-foundation/dist/composition/scaffold-filesystem.js";
import { assertSchema } from "../packages/engineering-foundation/dist/schema-catalog.js";
import { parseStrictYamlSource } from "../packages/engineering-foundation/dist/features/configuration-input/yaml.js";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const fixtureRoot = join(
  repositoryRoot,
  "tests",
  "fixtures",
  "scaffolding-authority-consumer"
);
const crashWorkerPath = join(
  repositoryRoot,
  "tests",
  "fixtures",
  "scaffolding-crash-worker.mjs"
);
const filesystemAuthorityWorkspaceModulePath = join(
  repositoryRoot,
  "packages",
  "engineering-foundation",
  "dist",
  "composition",
  "scaffold-filesystem.js"
);

async function createConsumer() {
  const root = await mkdtemp(join(tmpdir(), "foundation-scaffolding-authority-"));
  await cp(fixtureRoot, root, { recursive: true });
  return root;
}

async function plan(root) {
  return planScaffoldFromFile({
    consumerRoot: root,
    intentPath: "intents/create-fixture.yaml"
  });
}

function ownerPath(root) {
  return join(root, "docs", "decisions", "adr-0060.md");
}

function catalogPath(root) {
  return join(root, "architecture", "package-catalog.yaml");
}

function configPath(root) {
  return join(root, "architecture", "foundation", "scaffolding.yaml");
}

function journalPath(root) {
  return join(root, ".agent-teams-local", "scaffolding-transaction.json");
}

async function assertCurrentJournal(root) {
  const envelope = JSON.parse(await readFile(journalPath(root), "utf8"));
  assert.equal(envelope.schemaVersion, 6);
  assert.equal(envelope.format, "agent-teams.repository-mutation.transaction-envelope/v1");
  assert.equal(envelope.payload.schemaVersion, 1);
}

async function setOwnerStatus(root, status) {
  const path = ownerPath(root);
  await writeFile(
    path,
    (await readFile(path, "utf8")).replace(/^status: .+$/mu, `status: ${status}`),
    "utf8"
  );
}

async function assertMissing(path) {
  await assert.rejects(stat(path), /ENOENT/u);
}

async function assertAllOutputsMissing(root, scaffoldPlan, except = new Set()) {
  for (const operation of scaffoldPlan.operations) {
    if (!except.has(operation.path)) {
      await assertMissing(join(root, ...operation.path.split("/")));
    }
  }
}

function withRecomputedPlanDigest(planValue) {
  const { planDigest: _planDigest, ...body } = planValue;
  return { ...body, planDigest: sha256Json(body) };
}

function withRecomputedReceiptDigest(receiptValue) {
  const { receiptDigest: _receiptDigest, ...body } = receiptValue;
  return { ...body, receiptDigest: sha256Json(body) };
}

async function waitForCrashPoint(child) {
  return new Promise((resolve, reject) => {
    let output = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.stdout.on("data", (chunk) => {
      output += chunk;
      if (output.includes("FOUNDATION_CRASH_POINT")) {
        resolve();
      }
    });
    child.once("exit", (code, signal) => {
      reject(
        new Error(
          `Crash worker exited before the fault point: code=${String(code)} signal=${String(signal)} ${stderr}`
        )
      );
    });
  });
}

async function waitForExit(child) {
  if (child.exitCode === null && child.signalCode === null) {
    await new Promise((resolve) => {
      child.once("exit", () => {
        resolve();
      });
    });
  }
}

async function crashDuringApply(root, scaffoldPlan, phase, operationIndex) {
  const planPath = join(root, "crash-plan.json");
  await writeFile(planPath, `${JSON.stringify(scaffoldPlan, null, 2)}\n`);
  const child = spawn(
    process.execPath,
    [
      crashWorkerPath,
      filesystemAuthorityWorkspaceModulePath,
      root,
      planPath,
      "applyAuthorityFilesystemScaffoldWithFaultInjection",
      phase,
      ...(operationIndex === undefined ? [] : [String(operationIndex)])
    ],
    { stdio: ["ignore", "pipe", "pipe"] }
  );
  await waitForCrashPoint(child);
  let killed = false;
  try {
    await utimes(
      join(root, ".agent-teams-local", "foundation-operation.lock"),
      new Date(0),
      new Date(0)
    ).catch((error) => {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
        throw error;
      }
    });
  } finally {
    killed = child.kill("SIGKILL");
    await waitForExit(child);
  }
  assert.equal(killed, true);
}

test("compiles deterministic authority evidence and preserves LF/CRLF authority parity", async () => {
  const root = await createConsumer();
  const crlfRoot = await createConsumer();
  try {
    const first = await plan(root);
    const second = await plan(root);
    assert.equal(first.schemaVersion, 1);
    assert.deepEqual(first, second);
    assert.equal(first.readSet.length, 3);
    assert.equal(first.authorityEvidence.sources.length, 3);
    assert.equal(
      first.authorityEvidence.ownerDocument.path,
      "docs/decisions/adr-0060.md"
    );
    for (const path of [
      configPath(crlfRoot),
      catalogPath(crlfRoot),
      ownerPath(crlfRoot)
    ]) {
      await writeFile(
        path,
        (await readFile(path, "utf8")).replace(/\r?\n/gu, "\r\n"),
        "utf8"
      );
    }
    assert.deepEqual(first, await plan(crlfRoot));
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(crlfRoot, { recursive: true, force: true });
  }
});

test("fails closed when owner status, owner binding, or catalog binding changes after planning", async () => {
  const scenarios = [
    async (root) => setOwnerStatus(root, "proposed"),
    async (root) => {
      const replacement = join(root, "docs", "decisions", "other.md");
      await writeFile(
        replacement,
        "---\nid: ADR-0060\nstatus: accepted\n---\n\n# Replacement\n",
        "utf8"
      );
    },
    async (root) => {
      const replacement = join(root, "docs", "decisions", "moved.md");
      await writeFile(replacement, await readFile(ownerPath(root)), "utf8");
      await rm(ownerPath(root));
    },
    async (root) => {
      await writeFile(
        catalogPath(root),
        (await readFile(catalogPath(root), "utf8")).replace(
          "owner_document: ADR-0060",
          "owner_document: ADR-0061"
        ),
        "utf8"
      );
    }
  ];
  for (const mutateAuthority of scenarios) {
    const root = await createConsumer();
    try {
      const scaffoldPlan = await plan(root);
      await mutateAuthority(root);
      const receipt = await applyFilesystemScaffold(root, scaffoldPlan);
      assert.equal(receipt.outcome, "authority-stale");
      assert.equal(receipt.commit.state, "rolled-back");
      assert.notEqual(receipt.commit.state, "committed");
      await assertAllOutputsMissing(root, scaffoldPlan);
      await assertMissing(journalPath(root));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("does not allow target A authority evidence to authorize target B", async () => {
  const root = await createConsumer();
  try {
    const scaffoldPlan = structuredClone(await plan(root));
    scaffoldPlan.intent.targetRef = "testing.other";
    scaffoldPlan.target = {
      ...scaffoldPlan.target,
      id: "testing.other",
      path: "packages/testing/other"
    };
    scaffoldPlan.operations = scaffoldPlan.operations.map((operation) => ({
      ...operation,
      path: operation.path.replace(
        "packages/testing/generated/",
        "packages/testing/other/"
      )
    }));
    const forged = withRecomputedPlanDigest(scaffoldPlan);
    assert.throws(() => assertScaffoldPlanDigest(forged), /Evidence is not bound/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("binds each authority source role to its canonical path", async () => {
  const root = await createConsumer();
  try {
    const scaffoldPlan = structuredClone(await plan(root));
    const configSource = scaffoldPlan.authorityEvidence.sources.find(
      ({ role }) => role === "config"
    );
    const ownerSource = scaffoldPlan.authorityEvidence.sources.find(
      ({ role }) => role === "owner-document"
    );
    assert.ok(configSource);
    assert.ok(ownerSource);
    configSource.role = "owner-document";
    ownerSource.role = "config";
    const { evidenceDigest: _evidenceDigest, ...evidenceBody } =
      scaffoldPlan.authorityEvidence;
    scaffoldPlan.authorityEvidence.evidenceDigest = sha256Json({
      ...evidenceBody,
      sources: evidenceBody.sources.toSorted((left, right) =>
        left.role.localeCompare(right.role)
      )
    });
    const forged = withRecomputedPlanDigest(scaffoldPlan);

    assert.throws(
      () => assertScaffoldPlanDigest(forged),
      /source roles are not bound to canonical paths/u
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects unknown authority verifier/version and schema extensions", async () => {
  const scenarios = [
    async (root) => {
      await writeFile(
        configPath(root),
        (await readFile(configPath(root), "utf8")).replace(
          "foundation.markdown-yaml-owner",
          "consumer.unknown-verifier"
        ),
        "utf8"
      );
    },
    async (root) => {
      const source = await readFile(configPath(root), "utf8");
      const mutated = source.replace(
        /contractVersion: 1(\r?\n        parameters:)/u,
        "contractVersion: 2$1"
      );
      assert.notEqual(mutated, source, "Verifier version fixture must mutate.");
      await writeFile(configPath(root), mutated, "utf8");
    },
    async (root) => {
      await writeFile(
        configPath(root),
        `${await readFile(configPath(root), "utf8")}    forbidden: true\n`,
        "utf8"
      );
    }
  ];
  for (const mutateConfig of scenarios) {
    const root = await createConsumer();
    try {
      await mutateConfig(root);
      await assert.rejects(plan(root), /const|additional properties/u);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  const root = await createConsumer();
  try {
    const scaffoldPlan = await plan(root);
    const evidence = structuredClone(scaffoldPlan.authorityEvidence);
    evidence.extension = true;
    await assert.rejects(
      assertSchema(
        "scaffold-authority-evidence/v1",
        evidence,
        "scaffold-authority-evidence"
      ),
      /additional properties/u
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("preserves outputs and journal after revocation at first, middle, and final publication", async () => {
  for (const operationIndex of [0, 2, 4]) {
    const root = await createConsumer();
    try {
      const scaffoldPlan = await plan(root);
      const receipt = await applyAuthorityFilesystemScaffoldWithFaultInjection(
        root,
        scaffoldPlan,
        async (point) => {
          if (
            point.phase === "after-journal-operation-published" &&
            point.operationIndex === operationIndex
          ) {
            await setOwnerStatus(root, "proposed");
          }
        }
      );
      assert.equal(receipt.outcome, "recovery-required", String(operationIndex));
      assert.equal(receipt.commit.state, "recovery-required", String(operationIndex));
      assert.ok(receipt.operations.every(({ outcome }) => outcome === "unobserved"));
      for (const [index, operation] of scaffoldPlan.operations.entries()) {
        const outputPath = join(root, ...operation.path.split("/"));
        if (index <= operationIndex) {
          assert.deepEqual(
            await readFile(outputPath),
            Buffer.from(operation.after.contentBase64, "base64")
          );
        } else {
          await assertMissing(outputPath);
        }
      }
      await assertCurrentJournal(root);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("preserves preexisting and newly published postimages after authority becomes stale", async () => {
  const root = await createConsumer();
  try {
    const scaffoldPlan = await plan(root);
    const preexisting = scaffoldPlan.operations[0];
    assert.ok(preexisting);
    const preexistingPath = join(root, ...preexisting.path.split("/"));
    await mkdir(dirname(preexistingPath), { recursive: true });
    await writeFile(preexistingPath, Buffer.from(preexisting.after.contentBase64, "base64"));
    if (process.platform !== "win32") {
      await chmod(preexistingPath, 0o644);
    }
    const receipt = await applyAuthorityFilesystemScaffoldWithFaultInjection(
      root,
      scaffoldPlan,
      async (point) => {
        if (
          point.phase === "after-journal-operation-published" &&
          point.operationIndex === 1
        ) {
          await setOwnerStatus(root, "proposed");
        }
      }
    );
    assert.equal(receipt.outcome, "recovery-required");
    assert.deepEqual(
      await readFile(preexistingPath),
      Buffer.from(preexisting.after.contentBase64, "base64")
    );
    const published = scaffoldPlan.operations[1];
    assert.ok(published);
    assert.deepEqual(
      await readFile(join(root, ...published.path.split("/"))),
      Buffer.from(published.after.contentBase64, "base64")
    );
    await assertCurrentJournal(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("retains third-party state and journal when authority becomes stale", async () => {
  const root = await createConsumer();
  try {
    const scaffoldPlan = await plan(root);
    const first = scaffoldPlan.operations[0];
    assert.ok(first);
    const firstPath = join(root, ...first.path.split("/"));
    const receipt = await applyAuthorityFilesystemScaffoldWithFaultInjection(
      root,
      scaffoldPlan,
      async (point) => {
        if (
          point.phase === "after-journal-operation-published" &&
          point.operationIndex === 0
        ) {
          await writeFile(firstPath, "user-owned third state\n", "utf8");
          await setOwnerStatus(root, "proposed");
        }
      }
    );
    assert.equal(receipt.outcome, "recovery-required");
    assert.equal(receipt.commit.state, "recovery-required");
    await assertCurrentJournal(root);
    assert.equal(await readFile(firstPath, "utf8"), "user-owned third state\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("restart recovery preserves persisted outputs when authority was revoked", async () => {
  const root = await createConsumer();
  try {
    const scaffoldPlan = await plan(root);
    const first = scaffoldPlan.operations[0];
    assert.ok(first);
    await assert.rejects(
      applyAuthorityFilesystemScaffoldWithFaultInjection(root, scaffoldPlan, async (point) => {
        if (
          point.phase === "after-journal-operation-published" &&
          point.operationIndex === 0
        ) {
          await setOwnerStatus(root, "proposed");
          throw new Error("simulated process interruption");
        }
      }),
      /simulated process interruption/u
    );
    const receipt = await recoverFilesystemScaffold(root);
    assert.equal(receipt?.outcome, "recovery-required");
    assert.equal(receipt?.commit.state, "recovery-required");
    assert.deepEqual(
      await readFile(join(root, ...first.path.split("/"))),
      Buffer.from(first.after.contentBase64, "base64")
    );
    await assertCurrentJournal(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("forged persisted ownership never authorizes restart deletion", async () => {
  const root = await createConsumer();
  try {
    const scaffoldPlan = await plan(root);
    const first = scaffoldPlan.operations[0];
    assert.ok(first);
    await assert.rejects(
      applyAuthorityFilesystemScaffoldWithFaultInjection(root, scaffoldPlan, (point) => {
        if (point.phase === "after-journal-prepared") {
          throw new Error("interrupted-before-publication");
        }
      }),
      /interrupted-before-publication/u
    );
    const destination = join(root, ...first.path.split("/"));
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, Buffer.from(first.after.contentBase64, "base64"));
    const forged = JSON.parse(await readFile(journalPath(root), "utf8"));
    forged.payload.operations[0].state = "published";
    await writeFile(journalPath(root), `${JSON.stringify(forged, null, 2)}\n`, "utf8");
    await setOwnerStatus(root, "proposed");

    await assert.rejects(
      recoverFilesystemScaffold(root),
      /transaction slot is corrupt, tampered, or incompatible; it was preserved/iu,
    );
    assert.deepEqual(
      await readFile(destination),
      Buffer.from(first.after.contentBase64, "base64")
    );
    assert.match(await readFile(journalPath(root), "utf8"), /"published"/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("unverifiable authority preserves persisted outputs and journal", async () => {
  const root = await createConsumer();
  try {
    const scaffoldPlan = await plan(root);
    const first = scaffoldPlan.operations[0];
    assert.ok(first);
    await assert.rejects(
      applyAuthorityFilesystemScaffoldWithFaultInjection(root, scaffoldPlan, (point) => {
        if (
          point.phase === "after-journal-operation-published" &&
          point.operationIndex === 0
        ) {
          throw new Error("interrupted-after-publication");
        }
      }),
      /interrupted-after-publication/u
    );
    await writeFile(ownerPath(root), "not markdown frontmatter\n", "utf8");

    const receipt = await recoverFilesystemScaffold(root);
    assert.equal(receipt?.outcome, "recovery-required");
    assert.ok(receipt?.operations.every(({ outcome }) => outcome === "unobserved"));
    assert.match(
      receipt?.diagnostics[0]?.ruleId ?? "",
      /authority\.unverifiable/u
    );
    assert.deepEqual(
      await readFile(join(root, ...first.path.split("/"))),
      Buffer.from(first.after.contentBase64, "base64")
    );
    await assertCurrentJournal(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("never deletes an exact third-party replacement after publication", async () => {
  const root = await createConsumer();
  try {
    const scaffoldPlan = await plan(root);
    const first = scaffoldPlan.operations[0];
    assert.ok(first);
    const destination = join(root, ...first.path.split("/"));

    const receipt = await applyAuthorityFilesystemScaffoldWithFaultInjection(
      root,
      scaffoldPlan,
      async (point) => {
        if (
          point.phase === "after-journal-operation-published" &&
          point.operationIndex === 0
        ) {
          await rm(destination);
          await writeFile(
            destination,
            Buffer.from(first.after.contentBase64, "base64")
          );
          if (process.platform !== "win32") {
            await chmod(destination, 0o644);
          }
          await setOwnerStatus(root, "proposed");
        }
      }
    );

    assert.equal(receipt.outcome, "recovery-required");
    assert.deepEqual(
      await readFile(destination),
      Buffer.from(first.after.contentBase64, "base64")
    );
    await assertCurrentJournal(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("recovers journal progress at preparation, publishing, and published crash windows", async () => {
  for (const phase of [
    "after-journal-prepared",
    "after-journal-operation-publishing",
    "after-journal-operation-published"
  ]) {
    const root = await createConsumer();
    try {
      const scaffoldPlan = await plan(root);
      await assert.rejects(
        applyAuthorityFilesystemScaffoldWithFaultInjection(root, scaffoldPlan, (point) => {
          if (point.phase === phase && (phase === "after-journal-prepared" || point.operationIndex === 0)) {
            throw new Error(`interrupted:${phase}`);
          }
        }),
        new RegExp(`interrupted:${phase}`, "u")
      );
      const receipt = await recoverFilesystemScaffold(root);
      assert.equal(receipt?.outcome, "failed-recovered", phase);
      await assertMissing(journalPath(root));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("fails safely after process death at every source-bound publication boundary", async () => {
  for (const scenario of [
    { phase: "after-journal-temporary-synced", expected: "temporary-preserved", replaceTemporary: true, revokeAuthority: true },
    { phase: "after-journal-temporary-synced", operationIndex: 0, expected: "temporary-preserved" },
    { phase: "after-journal-prepared", expected: "failed-recovered" },
    {
      phase: "after-journal-operation-publishing",
      operationIndex: 0,
      expected: "failed-recovered"
    },
    {
      phase: "after-temporary-written",
      operationIndex: 0,
      expected: "recovery-required"
    },
    {
      phase: "after-temporary-synced",
      operationIndex: 0,
      expected: "recovery-required"
    },
    {
      phase: "after-hard-link",
      operationIndex: 0,
      expected: "recovery-required"
    },
    {
      phase: "after-journal-operation-published",
      operationIndex: 0,
      expected: "failed-recovered"
    },
    { phase: "before-final-authority-recheck", expected: "failed-recovered" },
    { phase: "after-final-verification", expected: "failed-recovered" },
    { phase: "after-journal-unlinked", expected: "already-applied-after-unlink" }
  ]) {
    const root = await createConsumer();
    try {
      const scaffoldPlan = await plan(root);
      await crashDuringApply(
        root,
        scaffoldPlan,
        scenario.phase,
        scenario.operationIndex
      );
      if (scenario.expected === "temporary-preserved") {
        const temporary = `${journalPath(root)}.tmp`;
        const bytes = await readFile(temporary);
        if (scenario.replaceTemporary === true) {
          await rename(temporary, `${temporary}.foundation-original`);
          await writeFile(temporary, bytes);
        }
        if (scenario.revokeAuthority === true) {
          await setOwnerStatus(root, "proposed");
        }
        await assert.rejects(
          recoverFilesystemScaffold(root),
          /cannot be proven transaction-owned|incomplete Foundation transaction transition/u,
        );
        assert.deepEqual(await readFile(temporary), bytes);
        if (scenario.replaceTemporary === true) {
          await assertMissing(journalPath(root));
        }
        continue;
      }
      const receipt = await recoverFilesystemScaffold(root);
      if (scenario.expected === "already-applied-after-unlink") {
        assert.equal(receipt, undefined, scenario.phase);
        assert.equal(
          (await applyFilesystemScaffold(root, scaffoldPlan)).outcome,
          "already-applied",
          scenario.phase
        );
      } else {
        assert.equal(receipt?.outcome, scenario.expected, scenario.phase);
      }
      if (
        scenario.expected === "failed-recovered" ||
        scenario.expected === "already-applied-after-unlink"
      ) {
        await assertMissing(journalPath(root));
        assert.equal(
          (await readdir(root, { recursive: true })).some((entry) =>
            entry.includes(".foundation-") && !entry.includes(".foundation-retired-evidence-") &&
            !entry.includes("foundation-operation.lock.released.")
          ),
          false,
          scenario.phase
        );
      } else {
        await assertCurrentJournal(root);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("validates the Plan and Receipt schemas, idempotency, and Windows-safe paths", async () => {
  const root = await createConsumer();
  try {
    const scaffoldPlan = await plan(root);
    await assertSchema("scaffold-plan/v1", scaffoldPlan, "scaffold-plan-authority");
    const applied = await applyFilesystemScaffold(root, scaffoldPlan);
    const replayed = await applyFilesystemScaffold(root, scaffoldPlan);
    assert.equal(applied.outcome, "applied");
    assert.equal(replayed.outcome, "already-applied");
    assert.equal(await validateScaffoldReceipt(applied, scaffoldPlan), applied);
    const forged = structuredClone(applied);
    forged.extension = true;
    await assert.rejects(validateScaffoldReceipt(forged, scaffoldPlan));

    const emptyRecoveryRequired = withRecomputedReceiptDigest({
      ...structuredClone(applied),
      outcome: "recovery-required",
      commit: {
        state: "recovery-required",
        atomicity: "journaled-recoverable"
      },
      operations: []
    });
    assert.throws(
      () => assertScaffoldReceiptDigest(emptyRecoveryRequired, scaffoldPlan),
      /requires operation evidence/u
    );
    await assert.rejects(
      validateScaffoldReceipt(emptyRecoveryRequired, scaffoldPlan),
      /must NOT have fewer than 1 items/u
    );

    const oversizedReadSet = structuredClone(scaffoldPlan);
    oversizedReadSet.readSet.push(structuredClone(oversizedReadSet.readSet[0]));
    await assert.rejects(
      assertSchema("scaffold-plan/v1", oversizedReadSet, "scaffold-plan-authority"),
      /must NOT have more than 3 items/u
    );

    const configValue = parseStrictYamlSource(
      await readFile(configPath(root), "utf8"),
      "scaffolding-config-authority"
    );
    configValue.compositions[0].authorityVerifiers.push(
      structuredClone(configValue.compositions[0].authorityVerifiers[0])
    );
    await assert.rejects(
      assertSchema("scaffolding-config/v1", configValue, "scaffolding-config-authority"),
      /must NOT have more than 1 items/u
    );

    const memoryReceipt = structuredClone(applied);
    memoryReceipt.adapter.id = "foundation.memory/v1";
    memoryReceipt.commit.atomicity = "memory-atomic";
    await assert.rejects(validateScaffoldReceipt(memoryReceipt, scaffoldPlan));

    const forgedJournal = {
      schemaVersion: 1,
      state: "PREPARED",
      plan: structuredClone(scaffoldPlan),
      operations: scaffoldPlan.operations.map((operation) => ({
        operationId: operation.id,
        path: operation.path,
        state: "pending"
      }))
    };
    forgedJournal.plan.compiler.extension = true;
    await assert.rejects(
      assertSchema(
        "scaffold-recovery-journal/v1",
        forgedJournal,
        "scaffold-recovery-journal-authority"
      ),
      /additional properties/u
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }

  const unsafeRoot = await createConsumer();
  try {
    await writeFile(
      catalogPath(unsafeRoot),
      (await readFile(catalogPath(unsafeRoot), "utf8")).replace(
        "packages/testing/generated",
        "CON/generated"
      ),
      "utf8"
    );
    const unsafePlan = await plan(unsafeRoot);
    await assert.rejects(
      applyFilesystemScaffold(unsafeRoot, unsafePlan),
      /operation path is unsafe/u
    );
  } finally {
    await rm(unsafeRoot, { recursive: true, force: true });
  }
});
