import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { Ajv2020 } from "ajv/dist/2020.js";

import { NodeArchitectureDecisionFingerprint } from "../packages/engineering-foundation/dist/capabilities/governance-architecture-decisions/adapters/outbound/crypto/node-architecture-decision-fingerprint.js";
import { FilesystemArchitectureDecisionBaselineRepository } from "../packages/engineering-foundation/dist/capabilities/governance-architecture-decisions/adapters/outbound/filesystem/filesystem-architecture-decision-baseline-repository.js";
import { immutableArchitectureDecisionPayload } from "../packages/engineering-foundation/dist/capabilities/governance-architecture-decisions/application/model/architecture-decision.js";
import { analyzeArchitectureDecisions } from "../packages/engineering-foundation/dist/capabilities/governance-architecture-decisions/application/use-cases/analyze-architecture-decisions.js";
import { loadCapabilityConfig } from "../packages/engineering-foundation/dist/capabilities/governance-architecture-decisions/contract/config.js";
import { FilesystemMarkdownRepository } from "../packages/engineering-foundation/dist/documentation-observation/adapters/outbound/filesystem/filesystem-markdown-repository.js";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const fixtureRoot = join(
  repositoryRoot,
  "tests",
  "fixtures",
  "governance-architecture-decisions",
  "valid"
);
const configSchemaPath = join(
  repositoryRoot,
  "packages",
  "engineering-foundation",
  "schemas",
  "governance-architecture-decisions",
  "v1.schema.json"
);
const baselineSchemaPath = join(
  repositoryRoot,
  "packages",
  "engineering-foundation",
  "schemas",
  "governance-architecture-decision-baseline",
  "v1.schema.json"
);

async function withFixture(callback) {
  const root = await mkdtemp(join(tmpdir(), "foundation-architecture-decisions-"));
  try {
    await cp(fixtureRoot, root, { recursive: true });
    return await callback(root);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}

async function analyze(root) {
  const policy = await loadCapabilityConfig(root, "governance-architecture-decisions.yaml");
  return analyzeArchitectureDecisions(
    { consumerRoot: root, policy },
    {
      baselineRepository: new FilesystemArchitectureDecisionBaselineRepository(),
      fingerprint: new NodeArchitectureDecisionFingerprint(),
      markdownRepository: new FilesystemMarkdownRepository()
    }
  );
}

function ruleIds(diagnostics) {
  return diagnostics.map((diagnostic) => diagnostic.ruleId).toSorted();
}

test("accepts a complete ADR identity, lifecycle, index, and immutable baseline", async () => {
  await withFixture(async (root) => {
    assert.deepEqual(await analyze(root), []);
  });
});

test("validates capability configuration and accepted baseline schemas", async () => {
  const ajv = new Ajv2020({ strict: true });
  const configSchema = JSON.parse(await readFile(configSchemaPath, "utf8"));
  const baselineSchema = JSON.parse(await readFile(baselineSchemaPath, "utf8"));
  const validateConfig = ajv.compile(configSchema);
  const validateBaseline = ajv.compile(baselineSchema);
  await withFixture(async (root) => {
    const config = await loadCapabilityConfig(root, "governance-architecture-decisions.yaml");
    const baseline = JSON.parse(
      await readFile(join(root, "architecture", "accepted-decisions.json"), "utf8")
    );
    assert.equal(validateConfig({
      schemaVersion: 1,
      adrRoots: config.adrRoots,
      index: config.index,
      acceptedBaselinePath: config.acceptedBaselinePath
    }), true, JSON.stringify(validateConfig.errors));
    assert.equal(validateBaseline(baseline), true, JSON.stringify(validateBaseline.errors));
  });
});

test("detects ADR identity, index placement, and bidirectional supersession failures", async () => {
  await withFixture(async (root) => {
    await writeFile(
      join(root, "docs", "decisions", "0004_bad-name.md"),
      "---\nid: ADR-0005\nstatus: proposed\n---\n\n# ADR-0005: Bad filename\n",
      "utf8"
    );
    await writeFile(
      join(root, "docs", "decisions", "0003-legacy-decision-history.md"),
      "---\nid: ADR-0003\nstatus: superseded\n---\n\n# ADR-0003: Legacy decision history\n",
      "utf8"
    );
    const ids = ruleIds(await analyze(root));
    assert.ok(ids.includes("governance.architecture-decisions.filename-mismatch"));
    assert.ok(ids.includes("governance.architecture-decisions.index-membership"));
    assert.ok(ids.includes("governance.architecture-decisions.supersedes-mismatch"));
  });
});

test("rejects mutation of accepted decision content against its immutable baseline", async () => {
  await withFixture(async (root) => {
    const path = join(
      root,
      "docs",
      "decisions",
      "0002-use-immutable-decision-baselines.md"
    );
    const source = await readFile(path, "utf8");
    await writeFile(
      path,
      source.replace("protected by a released immutable baseline", "rewritten after acceptance"),
      "utf8"
    );
    assert.ok(
      ruleIds(await analyze(root)).includes(
        "governance.architecture-decisions.accepted-decision-mutated"
      )
    );
  });
});

test("does not treat lifecycle status and successor references as immutable decision content", async () => {
  await withFixture(async (root) => {
    const markdownRepository = new FilesystemMarkdownRepository();
    const observation = await markdownRepository.observe({
      consumerRoot: root,
      roots: ["docs/decisions"]
    });
    const document = observation.documents.find(
      (candidate) => candidate.repositoryPath.endsWith("0002-use-immutable-decision-baselines.md")
    );
    assert.ok(document !== undefined);
    assert.equal(document.frontmatter.kind, "valid");
    if (document.frontmatter.kind !== "valid") {
      return;
    }
    const metadata = document.frontmatter.value;
    assert.equal(typeof metadata, "object");
    if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) {
      return;
    }
    const original = {
      document,
      id: "ADR-0002",
      metadata,
      status: "accepted",
      supersedes: ["ADR-0003"],
      supersededBy: []
    };
    const transitioned = {
      ...original,
      metadata: { ...metadata, status: "superseded", superseded_by: ["ADR-0004"] },
      status: "superseded",
      supersededBy: ["ADR-0004"]
    };
    assert.equal(
      immutableArchitectureDecisionPayload(original),
      immutableArchitectureDecisionPayload(transitioned)
    );
  });
});

test("requires an available accepted-decision baseline", async () => {
  await withFixture(async (root) => {
    await rm(join(root, "architecture", "accepted-decisions.json"));
    assert.ok(
      ruleIds(await analyze(root)).includes(
        "governance.architecture-decisions.accepted-baseline-unavailable"
      )
    );
  });
});
