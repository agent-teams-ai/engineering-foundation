import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { FilesystemMarkdownRepository } from "@agent-teams/document-authoring/observation";
import { createDocumentationLocalReferencesCapability } from "../dist/capabilities/documentation-local-references/module.js";
import { digestMarkdownSource } from "../dist/capabilities/documentation-local-references/adapters/outbound/crypto/node-markdown-source-digest.js";
import { loadCapabilityConfig } from "../dist/capabilities/documentation-local-references/adapters/inbound/configuration/load-capability-config.js";
import { assertSchema } from "../dist/schema-catalog.js";
import {
  artifactPath,
  assertHistorical,
  configuration,
  invalidArtifactRule,
  invalidReferenceRule,
  run,
  runCli,
  source,
  withFixture,
  writeConfiguration,
} from "./documentation-historical-references-fixture.ts";

test("v2 preserves raw UTF-8 BOM, CRLF and non-ASCII bytes from the same observation", async () => {
  await withFixture(async (root) => {
    const observation = await new FilesystemMarkdownRepository().observe({
      consumerRoot: root,
      roots: ["docs", "ai-docs", "architecture"],
    });
    const document = observation.documents.find((entry) => entry.repositoryPath === artifactPath);
    assert.ok(document);
    assert.deepEqual(
      Buffer.from(document.source, "utf8"),
      await readFile(join(root, artifactPath)),
    );
    assert.equal(document.source.charCodeAt(0), 0xfeff);
    assert.equal(
      digestMarkdownSource(document.source),
      createHash("sha256").update(source).digest("hex"),
    );
    assertHistorical(await run(root));
  });
});

test("real CLI retains historical infos and summary at exit zero", async () => {
  await withFixture(async (root) => {
    const result = await runCli(root);
    assert.equal(result.status, 0);
    assert.equal(result.report.outcome, "passed");
    assert.deepEqual(result.report.summary, { errors: 0, warnings: 0, infos: 3 });
    assert.equal(result.report.capabilities.length, 1);
    const report = result.report.capabilities[0];
    assert.ok(report);
    assertHistorical(report);
    assert.deepEqual(await readFile(join(root, artifactPath)), source);
  });
});

test("byte drift rejects the whole artifact and retains every original absolute finding", async () => {
  await withFixture(async (root) => {
    assertHistorical(await run(root));
    await writeFile(
      join(root, artifactPath),
      Buffer.concat([source, Buffer.from("Changed bytes.\n")]),
    );
    const report = await run(root);
    assert.equal(report.outcome, "violations");
    assert.deepEqual(report.summary, { errors: 4, warnings: 0, infos: 0 });
    assert.equal(
      report.diagnostics.filter((entry) => entry.ruleId === invalidReferenceRule).length,
      3,
    );
    assert.ok(
      report.diagnostics.some(
        (entry) =>
          entry.ruleId === invalidArtifactRule &&
          entry.evidence.some(
            (item) =>
              item.kind === "historical-artifact-rejection" &&
              item.value === "source-digest-mismatch",
          ),
      ),
    );
  });
});

test("a renewed hash cannot authorize a newly undeclared absolute occurrence", async () => {
  await withFixture(async (root) => {
    const changed = Buffer.concat([source, Buffer.from("[New](/mnt/undeclared.txt)\n")]);
    await writeFile(join(root, artifactPath), changed);
    await writeConfiguration(root, configuration(changed));
    const report = await run(root);
    assert.equal(report.outcome, "violations");
    assert.deepEqual(report.summary, { errors: 5, warnings: 0, infos: 0 });
    assert.equal(
      report.diagnostics.filter((entry) => entry.ruleId === invalidReferenceRule).length,
      4,
    );
    assert.ok(report.diagnostics.some((entry) => entry.ruleId === invalidArtifactRule));
  });
});

test("stale, partial, kind, line, column and target declarations all fail closed", async () => {
  await withFixture(async (root) => {
    const cases = [
      (config: ReturnType<typeof configuration>) => {
        config.historicalArtifacts[0]?.references.pop();
      },
      (config: ReturnType<typeof configuration>) => {
        config.historicalArtifacts[0]?.references.push({
          kind: "link",
          line: 8,
          column: 1,
          rawTarget: "guide.md#ready",
        });
      },
      ...(["kind", "line", "column", "rawTarget"] as const).map(
        (field) => (config: ReturnType<typeof configuration>) => {
          const reference = config.historicalArtifacts[0]?.references[0];
          assert.ok(reference);
          if (field === "kind") {
            reference.kind = "definition";
          } else if (field === "line") {
            reference.line = 20;
          } else if (field === "column") {
            reference.column = 2;
          } else {
            reference.rawTarget = "/mnt/different.txt";
          }
        },
      ),
    ];
    for (const mutate of cases) {
      const config = configuration();
      mutate(config);
      await writeConfiguration(root, config);
      const report = await run(root);
      assert.equal(report.outcome, "violations");
      assert.deepEqual(report.summary, { errors: 4, warnings: 0, infos: 0 });
      assert.equal(
        report.diagnostics.filter((entry) => entry.ruleId === invalidReferenceRule).length,
        3,
      );
      assert.ok(report.diagnostics.some((entry) => entry.ruleId === invalidArtifactRule));
    }
  });
});

test("a renewed hash cannot retain a declaration after all absolute references disappear", async () => {
  await withFixture(async (root) => {
    const changed = Buffer.from("# Retained audit\n\n[Relative](guide.md#ready)\n", "utf8");
    await writeFile(join(root, artifactPath), changed);
    await writeConfiguration(root, configuration(changed));
    const report = await run(root);
    assert.equal(report.outcome, "violations");
    assert.deepEqual(report.summary, { errors: 1, warnings: 0, infos: 0 });
    assert.equal(report.diagnostics[0]?.ruleId, invalidArtifactRule);
  });
});

test("missing and case-aliased declared sources reject even without matching absolute observations", async () => {
  await withFixture(async (root) => {
    const config = configuration();
    const artifact = config.historicalArtifacts[0];
    assert.ok(artifact);
    artifact.path = "docs/AUDIT.md";
    await writeConfiguration(root, config);
    let report = await run(root);
    assert.equal(report.outcome, "violations");
    assert.deepEqual(report.summary, { errors: 4, warnings: 0, infos: 0 });
    assert.equal(
      report.diagnostics.filter((entry) => entry.ruleId === invalidReferenceRule).length,
      3,
    );
    assert.ok(report.diagnostics.some((entry) => entry.ruleId === invalidArtifactRule));
    await rm(join(root, artifactPath));
    await writeConfiguration(root, configuration());
    report = await run(root);
    assert.equal(report.outcome, "violations");
    assert.deepEqual(report.summary, { errors: 1, warnings: 0, infos: 0 });
    assert.equal(report.diagnostics[0]?.ruleId, invalidArtifactRule);
  });
});

test("a symlinked artifact source is never admitted", async () => {
  await withFixture(async (root) => {
    await rm(join(root, artifactPath));
    await mkdir(join(root, "retained-source"));
    await writeFile(join(root, "retained-source/audit.md"), source);
    await symlink(
      join(root, "retained-source"),
      join(root, "docs/archive"),
      process.platform === "win32" ? "junction" : "dir",
    );
    const config = configuration();
    const artifact = config.historicalArtifacts[0];
    assert.ok(artifact);
    artifact.path = "docs/archive/audit.md";
    await writeConfiguration(root, config);
    const report = await run(root);
    assert.equal(report.outcome, "violations");
    assert.equal(report.summary.infos, 0);
    assert.ok(report.diagnostics.some((entry) => entry.ruleId === invalidArtifactRule));
    assert.ok(
      report.diagnostics.some(
        (entry) => entry.ruleId === "documentation.local-references.symbolic-link",
      ),
    );
  });
});

test("invalid UTF-8 source cannot acquire a matching historical digest", async () => {
  await withFixture(async (root) => {
    const invalid = Buffer.concat([source, Buffer.from([0xff])]);
    await writeFile(join(root, artifactPath), invalid);
    await writeConfiguration(root, configuration(invalid));
    const report = await run(root);
    assert.equal(report.outcome, "violations");
    assert.equal(report.summary.infos, 0);
    assert.ok(report.diagnostics.some((entry) => entry.ruleId === invalidArtifactRule));
    assert.ok(
      report.diagnostics.some(
        (entry) => entry.ruleId === "documentation.local-references.source-unavailable",
      ),
    );
  });
});

test("ordinary link, anchor, escape and encoding failures inside admitted artifacts remain errors", async () => {
  await withFixture(async (root) => {
    for (const [target, expectedRule] of [
      ["missing.md", "broken-link"],
      ["guide.md#missing", "missing-anchor"],
      ["../../outside.md", "repository-escape"],
      ["%ZZ", "invalid-reference"],
    ] as const) {
      const changed = Buffer.concat([source, Buffer.from("[Ordinary](" + target + ")\n")]);
      await writeFile(join(root, artifactPath), changed);
      await writeConfiguration(root, configuration(changed));
      const report = await run(root);
      assert.equal(report.outcome, "violations");
      assert.deepEqual(report.summary, { errors: 1, warnings: 0, infos: 3 });
      assert.ok(
        report.diagnostics.some(
          (entry) =>
            entry.ruleId === "documentation.local-references." + expectedRule &&
            entry.severity === "error",
        ),
      );
    }
  });
});

test("all configured roots remain checked and mixed CLI findings exit nonzero", async () => {
  await withFixture(async (root) => {
    for (const directory of ["docs", "ai-docs", "architecture"]) {
      const target = directory === "docs" ? "/mnt/unlisted.txt" : "absent.md";
      await writeFile(join(root, directory, "broken.md"), "[Broken](" + target + ")\n", "utf8");
    }
    const result = await runCli(root);
    assert.equal(result.status, 1);
    assert.equal(result.report.outcome, "violations");
    assert.deepEqual(result.report.summary, { errors: 3, warnings: 0, infos: 3 });
    const errors = result.report.capabilities[0]?.diagnostics.filter(
      (entry) => entry.severity === "error",
    );
    assert.deepEqual(errors?.map((entry) => entry.location.path).toSorted(), [
      "ai-docs/broken.md",
      "architecture/broken.md",
      "docs/broken.md",
    ]);
    assert.equal(
      errors?.find((entry) => entry.location.path === "docs/broken.md")?.ruleId,
      invalidReferenceRule,
    );
  });
});

test("v2 refuses empty, duplicate, out-of-root and malformed declarations with version two reports", async () => {
  await withFixture(async (root) => {
    const ordinary = configuration();
    const artifact = ordinary.historicalArtifacts[0];
    assert.ok(artifact);
    const first = artifact.references[0];
    assert.ok(first);
    const configurations: unknown[] = [
      { ...ordinary, historicalArtifacts: [] },
      { ...ordinary, historicalArtifacts: [{ ...artifact, references: [] }] },
      { ...ordinary, historicalArtifacts: [artifact, artifact] },
      {
        ...ordinary,
        historicalArtifacts: [artifact, { ...artifact, sha256: "0".repeat(64) }],
      },
      { ...ordinary, historicalArtifacts: [{ ...artifact, path: "outside/audit.md" }] },
      { ...ordinary, historicalArtifacts: [{ ...artifact, path: "../audit.md" }] },
      { ...ordinary, historicalArtifacts: [{ ...artifact, path: "docs/../audit.md" }] },
      { ...ordinary, historicalArtifacts: [{ ...artifact, path: "/docs/audit.md" }] },
      { ...ordinary, historicalArtifacts: [{ ...artifact, sha256: "not-a-digest" }] },
      {
        ...ordinary,
        historicalArtifacts: [
          {
            ...artifact,
            references: [...artifact.references, { ...first, rawTarget: "/mnt/conflict.txt" }],
          },
        ],
      },
      { ...ordinary, historicalArtifacts: [{ ...artifact, references: [{ ...first, line: 0 }] }] },
      {
        ...ordinary,
        historicalArtifacts: [{ ...artifact, references: [{ ...first, column: 1.5 }] }],
      },
      { ...ordinary, historicalArtifacts: [{ ...artifact, ignored: true }] },
      {
        ...ordinary,
        historicalArtifacts: [{ ...artifact, sha256: artifact.sha256.toUpperCase() }],
      },
      {
        ...ordinary,
        historicalArtifacts: [{ ...artifact, references: [{ ...first, rawTarget: "" }] }],
      },
      {
        ...ordinary,
        historicalArtifacts: [{ ...artifact, references: [{ ...first, ignored: true }] }],
      },
      {
        ...ordinary,
        historicalArtifacts: Array.from({ length: 101 }, (_, index) => ({
          ...artifact,
          path: "docs/audit-" + index + ".md",
        })),
      },
      {
        ...ordinary,
        historicalArtifacts: [
          {
            ...artifact,
            references: Array.from({ length: 1001 }, (_, index) => ({
              ...first,
              line: index + 1,
            })),
          },
        ],
      },
      { ...ordinary, excludedFiles: [artifactPath] },
      { ...ordinary, waivers: [artifactPath] },
    ];
    for (const config of configurations) {
      await writeConfiguration(root, config);
      const report = await run(root);
      assert.equal(report.capabilityConfigSchemaVersion, 2);
      assert.equal(report.outcome, "invalid-input", JSON.stringify(config));
      assert.ok(report.problem);
      assert.equal(report.summary.infos, 0);
    }
  });
});

test("v2 schema rejection happens before normalization and preserves the rejection", async () => {
  const input = { schemaVersion: 2, historicalArtifacts: "invalid" };
  const failure = new Error("schema rejected v2");
  let calls = 0;
  let version: number | undefined;
  await assert.rejects(
    loadCapabilityConfig(
      {
        readYaml: async () => input,
        assertSchema: async (id, observed, phase) => {
          assert.equal(id, "documentation-local-references/v2");
          assert.equal(observed, input);
          assert.equal(phase, "documentation-local-references-config");
          calls += 1;
          throw failure;
        },
      },
      "memory-consumer",
      "references.yaml",
      undefined,
      (observed) => {
        version = observed;
      },
    ),
    (error: unknown) => error === failure,
  );
  assert.equal(calls, 1);
  assert.equal(version, 2);
});

test("v2 observation failures preserve requested schema identity", async () => {
  await withFixture(async (root) => {
    await rm(join(root, "architecture"), { recursive: true });
    const report = await run(root);
    assert.equal(report.capabilityConfigSchemaVersion, 2);
    assert.equal(report.outcome, "violations");
    assert.ok(
      report.diagnostics.some(
        (entry) => entry.ruleId === "documentation.local-references.source-unavailable",
      ),
    );
  });
});

test("cancellation after v2 schema admission retains version two in the failure report", async () => {
  await withFixture(async (root) => {
    const controller = new AbortController();
    const cancelledCapability = createDocumentationLocalReferencesCapability({
      assertSchema: async (id, input, phase) => {
        await assertSchema(id, input, phase);
        controller.abort();
      },
    });
    const report = await cancelledCapability.run({
      consumerRoot: root,
      configPath: "references.yaml",
      signal: controller.signal,
    });
    assert.equal(report.capabilityConfigSchemaVersion, 2);
    assert.equal(report.outcome, "cancelled");
    assert.deepEqual(report.summary, { errors: 0, warnings: 0, infos: 0 });
    assert.ok(report.problem);
  });
});

test("v1 retains its ordinary absolute rejection and rejects the v2-only declaration", async () => {
  await withFixture(async (root) => {
    const { historicalArtifacts, ...current } = configuration();
    await writeConfiguration(root, { ...current, schemaVersion: 1 });
    const report = await run(root);
    assert.equal(report.capabilityConfigSchemaVersion, 1);
    assert.equal(report.outcome, "violations");
    assert.deepEqual(report.summary, { errors: 3, warnings: 0, infos: 0 });
    assert.ok(report.diagnostics.every((entry) => entry.ruleId === invalidReferenceRule));
    await writeConfiguration(root, { ...current, schemaVersion: 1, historicalArtifacts });
    const rejected = await run(root);
    assert.equal(rejected.capabilityConfigSchemaVersion, 1);
    assert.equal(rejected.outcome, "invalid-input");
  });
});
