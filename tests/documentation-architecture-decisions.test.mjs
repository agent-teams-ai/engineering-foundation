import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { cp, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

import { Ajv2020 } from "ajv/dist/2020.js";

import { CapabilityInputError } from "../packages/engineering-foundation/dist/features/validation-reporting/api.js";
import { NodeArchitectureDecisionFingerprint } from "../packages/engineering-foundation/dist/capabilities/governance-architecture-decisions/adapters/outbound/crypto/node-architecture-decision-fingerprint.js";
import { FilesystemArchitectureDecisionBaselineRepository } from "../packages/engineering-foundation/dist/capabilities/governance-architecture-decisions/adapters/outbound/filesystem/filesystem-architecture-decision-baseline-repository.js";
import { immutableArchitectureDecisionPayload } from "../packages/engineering-foundation/dist/capabilities/governance-architecture-decisions/application/model/architecture-decision.js";
import {
  analyzeArchitectureDecisionEvidence,
  analyzeArchitectureDecisions,
} from "../packages/engineering-foundation/dist/capabilities/governance-architecture-decisions/application/use-cases/analyze-architecture-decisions.js";
import { promoteArchitectureDecisionBaseline as promoteBaselineUseCase } from "../packages/engineering-foundation/dist/capabilities/governance-architecture-decisions/application/use-cases/promote-architecture-decision-baseline.js";
import { loadCapabilityConfig } from "../packages/engineering-foundation/dist/capabilities/governance-architecture-decisions/contract/config.js";
import {
  promoteArchitectureDecisionBaseline,
  readAcceptedArchitectureDecisionEvidence
} from "../packages/engineering-foundation/dist/capabilities/governance-architecture-decisions/module.js";
import { FilesystemMarkdownRepository } from "../packages/document-authoring/dist/documentation-observation/adapters/outbound/filesystem/filesystem-markdown-repository.js";

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
const cliPath = join(
  repositoryRoot,
  "packages",
  "engineering-foundation",
  "dist",
  "cli.js"
);
const baselineRepositoryModuleUrl = pathToFileURL(
  join(
    repositoryRoot,
    "packages",
    "engineering-foundation",
    "dist",
    "capabilities",
    "governance-architecture-decisions",
    "adapters",
    "outbound",
    "filesystem",
    "filesystem-architecture-decision-baseline-repository.js"
  )
).href;
const concurrentBaselineWriterScript = `
import { FilesystemArchitectureDecisionBaselineRepository } from ${JSON.stringify(baselineRepositoryModuleUrl)};

const input = JSON.parse(process.env.FOUNDATION_BASELINE_WRITE_INPUT ?? "");
const repository = new FilesystemArchitectureDecisionBaselineRepository();
process.stdout.write("READY\\n");
process.stdin.resume();
process.stdin.once("data", async () => {
  try {
    const writeResult = await repository.write(input);
    process.stdout.write(JSON.stringify({ kind: "fulfilled", writeResult }) + "\\n");
  } catch (error) {
    const code =
      typeof error === "object" &&
      error !== null &&
      "problem" in error &&
      typeof error.problem === "object" &&
      error.problem !== null &&
      "code" in error.problem
        ? error.problem.code
        : "UNKNOWN";
    process.stdout.write(JSON.stringify({ code, kind: "rejected" }) + "\\n");
  }
});
`;

function baselinePath(root) {
  return join(root, "architecture", "decisions", "accepted-decisions.json");
}

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

async function analyzeEvidence(root) {
  const policy = await loadCapabilityConfig(root, "governance-architecture-decisions.yaml");
  return analyzeArchitectureDecisionEvidence(
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

function hasProblemCode(error, code) {
  return error instanceof CapabilityInputError && error.problem.code === code;
}

function startConcurrentBaselineWriter(input) {
  const child = spawn(
    process.execPath,
    ["--input-type=module", "--eval", concurrentBaselineWriterScript],
    {
      env: { ...process.env, FOUNDATION_BASELINE_WRITE_INPUT: JSON.stringify(input) },
      stdio: ["pipe", "pipe", "pipe"]
    }
  );
  let stderr = "";
  let stdout = "";
  let ready = false;
  let rejectReady;
  let resolveReady;
  const readyPromise = new Promise((resolve, reject) => {
    rejectReady = reject;
    resolveReady = resolve;
  });
  const result = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (!ready) {
        rejectReady(
          new Error(
            `Concurrent baseline writer exited before ready: code=${String(code)} signal=${String(signal)} ${stderr}`
          )
        );
      }
      resolve({ code, signal, stderr, stdout });
    });
  });
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
    if (!ready && stdout.split(/\r?\n/u).includes("READY")) {
      ready = true;
      resolveReady();
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  return { child, ready: readyPromise, result };
}

function writerOutcome(result) {
  assert.equal(result.code, 0, result.stderr);
  const lastLine = result.stdout.trim().split(/\r?\n/u).at(-1);
  assert.notEqual(lastLine, undefined);
  return JSON.parse(lastLine);
}

function baselineWithDigest(baseline, digestCharacter) {
  const candidate = structuredClone(baseline);
  candidate.decisions[0].immutableDigest = `sha256:${digestCharacter.repeat(64)}`;
  return candidate;
}

async function writeFoundationConfig(root, declared = true) {
  const capabilities = declared
    ? "  governance.architecture-decisions:\n    configPath: governance-architecture-decisions.yaml\n"
    : "  workspace.dependency-declarations:\n    configPath: architecture/foundation/dependency-declarations.yaml\n";
  await writeFile(
    join(root, "foundation.config.yaml"),
    `schemaVersion: 1\nproject:\n  id: architecture-decision-fixture\ncapabilities:\n${capabilities}`,
    "utf8"
  );
}

test("accepts a complete ADR identity, lifecycle, index, and immutable baseline", async () => {
  await withFixture(async (root) => {
    assert.deepEqual(await analyze(root), []);
  });
});

test("returns the exact accepted ADR baseline snapshot it validates", async () => {
  await withFixture(async (root) => {
    const evidence = await analyzeEvidence(root);
    assert.deepEqual(evidence.diagnostics, []);
    assert.equal(evidence.baseline.kind, "valid");
    assert.equal(evidence.baseline.revision.startsWith("sha256:"), true);
  });
});

test("returns only currently accepted ADRs as immutable approval evidence", async () => {
  await withFixture(async (root) => {
    const evidence = await readAcceptedArchitectureDecisionEvidence({
      baselinePath: "architecture/decisions/accepted-decisions.json",
      configPath: "governance-architecture-decisions.yaml",
      consumerRoot: root
    });
    assert.deepEqual(evidence, {
      acceptedDecisionIds: ["ADR-0002"],
      acceptedDecisionPaths: [
        "docs/decisions/0002-use-immutable-decision-baselines.md"
      ]
    });
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
      await readFile(join(root, "architecture", "decisions", "accepted-decisions.json"), "utf8")
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

test("rejects redirecting accepted ADR history away from its stable anchor", async () => {
  await withFixture(async (root) => {
    const configPath = join(root, "governance-architecture-decisions.yaml");
    const source = await readFile(configPath, "utf8");
    await writeFile(
      configPath,
      source.replace(
        "architecture/decisions/accepted-decisions.json",
        "architecture/decisions/reset-history.json",
      ),
      "utf8",
    );
    await assert.rejects(
      loadCapabilityConfig(root, "governance-architecture-decisions.yaml"),
      /acceptedBaselinePath must be equal to constant/u,
    );
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

test("does not admit decisions with invalid IDs or relationship IDs into the catalog", async () => {
  await withFixture(async (root) => {
    await writeFile(
      join(root, "docs", "decisions", "0004-invalid-id.md"),
      "---\nid: decision-0004\nstatus: proposed\n---\n\n# decision-0004: Invalid identity\n",
      "utf8"
    );
    await writeFile(
      join(root, "docs", "decisions", "0001-keep-decision-format.md"),
      "---\nid: ADR-0001\nstatus: proposed\nsupersedes:\n  - not-an-adr\n---\n\n# ADR-0001: Keep the decision format\n",
      "utf8"
    );

    const evidence = await analyzeEvidence(root);
    assert.equal(
      evidence.diagnostics.filter(
        ({ ruleId }) =>
          ruleId === "governance.architecture-decisions.frontmatter-invalid"
      ).length,
      2
    );
    assert.equal(
      evidence.decisions.some(({ id }) => id === "decision-0004" || id === "ADR-0001"),
      false
    );
  });
});

test("validates both ADR relationship fields before admitting a decision", async () => {
  for (const relationshipField of ["supersedes", "superseded_by"]) {
    await withFixture(async (root) => {
      await writeFile(
        join(root, "docs", "decisions", "0001-keep-decision-format.md"),
        `---\nid: ADR-0001\nstatus: proposed\n${relationshipField}:\n  - not-an-adr\n---\n\n# ADR-0001: Keep the decision format\n`,
        "utf8"
      );

      const evidence = await analyzeEvidence(root);
      assert.ok(
        evidence.diagnostics.some(
          ({ ruleId }) =>
            ruleId === "governance.architecture-decisions.frontmatter-invalid"
        )
      );
      assert.equal(evidence.decisions.some(({ id }) => id === "ADR-0001"), false);
    });
  }
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
    await rm(baselinePath(root));
    assert.ok(
      ruleIds(await analyze(root)).includes(
        "governance.architecture-decisions.accepted-baseline-unavailable"
      )
    );
  });
});

test("promotes a deterministic accepted and superseded ADR baseline, then replays without a write", async () => {
  await withFixture(async (root) => {
    await rm(baselinePath(root));

    const first = await promoteArchitectureDecisionBaseline({
      consumerRoot: root,
      configPath: "governance-architecture-decisions.yaml"
    });
    assert.equal(first.writeResult, "created");
    assert.deepEqual(
      first.baseline.decisions.map((entry) => entry.id),
      ["ADR-0002", "ADR-0003"]
    );
    const sourceAfterFirstPromotion = await readFile(baselinePath(root), "utf8");
    assert.equal(sourceAfterFirstPromotion.endsWith("\n"), true);

    const replay = await promoteArchitectureDecisionBaseline({
      consumerRoot: root,
      configPath: "governance-architecture-decisions.yaml"
    });
    assert.equal(replay.writeResult, "unchanged");
    assert.equal(await readFile(baselinePath(root), "utf8"), sourceAfterFirstPromotion);
    assert.deepEqual(await analyze(root), []);
  });
});

test("does not rewrite an already canonical immutable baseline", async () => {
  await withFixture(async (root) => {
    const before = await readFile(baselinePath(root), "utf8");
    const promotion = await promoteArchitectureDecisionBaseline({
      consumerRoot: root,
      configPath: "governance-architecture-decisions.yaml"
    });
    assert.equal(promotion.writeResult, "unchanged");
    assert.equal(await readFile(baselinePath(root), "utf8"), before);
  });
});

test("treats platform line endings as the same canonical immutable baseline", async () => {
  await withFixture(async (root) => {
    const path = baselinePath(root);
    const canonical = await readFile(path, "utf8");
    const platformSource = canonical
      .replaceAll("\r\n", "\n")
      .replaceAll("\n", "\r\n");
    await writeFile(path, platformSource, "utf8");
    const promotion = await promoteArchitectureDecisionBaseline({
      consumerRoot: root,
      configPath: "governance-architecture-decisions.yaml"
    });
    assert.equal(promotion.writeResult, "unchanged");
    assert.equal(await readFile(path, "utf8"), platformSource);
  });
});

test("does not read or write a baseline until the complete ADR catalog is valid", async () => {
  await withFixture(async (root) => {
    await writeFile(
      join(root, "docs", "decisions", "0004-invalid.md"),
      "---\nid: ADR-0004\nstatus: accepted\n---\n\n# Wrong title\n",
      "utf8"
    );
    const policy = await loadCapabilityConfig(root, "governance-architecture-decisions.yaml");
    let reads = 0;
    let writes = 0;

    await assert.rejects(
      promoteBaselineUseCase(
        { consumerRoot: root, policy },
        {
          baselineRepository: {
            async read() {
              reads += 1;
              return { kind: "missing" };
            },
            async write() {
              writes += 1;
              return "created";
            }
          },
          fingerprint: new NodeArchitectureDecisionFingerprint(),
          markdownRepository: new FilesystemMarkdownRepository()
        }
      ),
      (error) =>
        hasProblemCode(
          error,
          "ARCHITECTURE_DECISION_BASELINE_PROMOTION_CATALOG_INVALID"
        )
    );
    assert.equal(reads, 0);
    assert.equal(writes, 0);
  });
});

test("refuses to delete a historical baseline entry during promotion", async () => {
  await withFixture(async (root) => {
    const originalBaseline = await readFile(baselinePath(root), "utf8");
    await rm(join(root, "docs", "decisions", "0003-legacy-decision-history.md"));
    const acceptedPath = join(
      root,
      "docs",
      "decisions",
      "0002-use-immutable-decision-baselines.md"
    );
    const acceptedSource = await readFile(acceptedPath, "utf8");
    await writeFile(
      acceptedPath,
      acceptedSource
        .replaceAll("\r\n", "\n")
        .replace("supersedes:\n  - ADR-0003\n", ""),
      "utf8"
    );
    await writeFile(
      join(root, "docs", "decisions", "README.md"),
      "# Architecture Decisions\n\n## Proposed Decisions\n\n- [ADR-0001: Keep the decision format](0001-keep-decision-format.md)\n\n## Accepted Decisions\n\n- [ADR-0002: Use immutable decision baselines](0002-use-immutable-decision-baselines.md)\n\n## Superseded Decisions\n",
      "utf8"
    );
    await assert.rejects(
      promoteArchitectureDecisionBaseline({
        consumerRoot: root,
        configPath: "governance-architecture-decisions.yaml"
      }),
      (error) =>
        hasProblemCode(
          error,
          "ARCHITECTURE_DECISION_BASELINE_PROMOTION_HISTORICAL_ENTRY_MISSING"
        )
    );
    assert.equal(await readFile(baselinePath(root), "utf8"), originalBaseline);
  });
});

test("refuses to mutate a historical baseline entry during promotion", async () => {
  await withFixture(async (root) => {
    const originalBaseline = await readFile(baselinePath(root), "utf8");
    const decisionPath = join(
      root,
      "docs",
      "decisions",
      "0002-use-immutable-decision-baselines.md"
    );
    const source = await readFile(decisionPath, "utf8");
    await writeFile(
      decisionPath,
      source.replace("protected by a released immutable baseline", "mutated after acceptance"),
      "utf8"
    );
    await assert.rejects(
      promoteArchitectureDecisionBaseline({
        consumerRoot: root,
        configPath: "governance-architecture-decisions.yaml"
      }),
      (error) =>
        hasProblemCode(
          error,
          "ARCHITECTURE_DECISION_BASELINE_PROMOTION_HISTORICAL_ENTRY_MUTATED"
        )
    );
    assert.equal(await readFile(baselinePath(root), "utf8"), originalBaseline);
  });
});

test("rejects baseline promotion paths that escape or traverse symbolic links", { skip: process.platform === "win32" }, async () => {
  await withFixture(async (root) => {
    const repository = new FilesystemArchitectureDecisionBaselineRepository();
    const baseline = {
      algorithm: "sha256",
      decisions: [],
      schemaVersion: 1
    };
    await assert.rejects(
      repository.write({
        baseline,
        consumerRoot: root,
        expected: { kind: "missing" },
        path: "../outside.json"
      }),
      (error) =>
        hasProblemCode(error, "ARCHITECTURE_DECISION_BASELINE_WRITE_UNSAFE_TARGET")
    );

    const outside = await mkdtemp(join(tmpdir(), "foundation-architecture-outside-"));
    try {
      await rm(join(root, "architecture"), { force: true, recursive: true });
      await symlink(outside, join(root, "architecture"));
      await assert.rejects(
        repository.write({
          baseline,
          consumerRoot: root,
          expected: { kind: "missing" },
          path: "architecture/decisions/accepted-decisions.json"
        }),
        (error) =>
          hasProblemCode(error, "ARCHITECTURE_DECISION_BASELINE_WRITE_UNSAFE_TARGET")
      );
      await assert.rejects(readFile(join(outside, "accepted-decisions.json"), "utf8"));
    } finally {
      await rm(outside, { force: true, recursive: true });
    }
  });
});

test("keeps runtime baseline validation aligned with schema path bounds", async () => {
  await withFixture(async (root) => {
    const repository = new FilesystemArchitectureDecisionBaselineRepository();
    await assert.rejects(
      repository.write({
        baseline: {
          algorithm: "sha256",
          decisions: [
            {
              id: "ADR-0001",
              immutableDigest: `sha256:${"a".repeat(64)}`,
              path: `${"x".repeat(298)}.md`
            }
          ],
          schemaVersion: 1
        },
        consumerRoot: root,
        expected: { kind: "missing" },
        path: "architecture/decisions/new-baseline.json"
      }),
      (error) =>
        hasProblemCode(error, "ARCHITECTURE_DECISION_BASELINE_WRITE_INVALID_INPUT")
    );
  });
});

test("refuses to replace a readable baseline with one above its read limit", async () => {
  await withFixture(async (root) => {
    const repository = new FilesystemArchitectureDecisionBaselineRepository();
    const current = await repository.read({
      consumerRoot: root,
      path: "architecture/decisions/accepted-decisions.json"
    });
    assert.equal(current.kind, "valid");
    if (current.kind !== "valid") {
      return;
    }
    const original = await readFile(baselinePath(root), "utf8");
    const pathPrefix = "docs/decisions/";
    const decisions = Array.from({ length: 10_000 }, (_, index) => {
      const identity = String(index).padStart(4, "0");
      const pathSuffix = `${identity}.md`;
      return {
        id: `ADR-${identity}`,
        immutableDigest: `sha256:${"a".repeat(64)}`,
        path: `${pathPrefix}${"x".repeat(300 - pathPrefix.length - pathSuffix.length)}${pathSuffix}`
      };
    });
    assert.ok(
      Buffer.byteLength(JSON.stringify({
        algorithm: "sha256",
        decisions,
        schemaVersion: 1
      }), "utf8") > 4 * 1024 * 1024
    );

    await assert.rejects(
      repository.write({
        baseline: { algorithm: "sha256", decisions, schemaVersion: 1 },
        consumerRoot: root,
        expected: { kind: "valid", revision: current.revision },
        path: "architecture/decisions/accepted-decisions.json"
      }),
      (error) =>
        hasProblemCode(error, "ARCHITECTURE_DECISION_BASELINE_WRITE_TOO_LARGE")
    );
    assert.equal(await readFile(baselinePath(root), "utf8"), original);
  });
});

test("rejects a baseline write when its expected revision changed concurrently", async () => {
  await withFixture(async (root) => {
    const repository = new FilesystemArchitectureDecisionBaselineRepository();
    const current = await repository.read({
      consumerRoot: root,
      path: "architecture/decisions/accepted-decisions.json"
    });
    assert.equal(current.kind, "valid");
    if (current.kind !== "valid") {
      return;
    }
    const original = await readFile(baselinePath(root), "utf8");
    await writeFile(baselinePath(root), `${original}\n`, "utf8");
    await assert.rejects(
      repository.write({
        baseline: current.value,
        consumerRoot: root,
        expected: { kind: "valid", revision: current.revision },
        path: "architecture/decisions/accepted-decisions.json"
      }),
      (error) =>
        hasProblemCode(error, "ARCHITECTURE_DECISION_BASELINE_WRITE_CONFLICT")
    );
    assert.equal(await readFile(baselinePath(root), "utf8"), `${original}\n`);
  });
});

test("serializes concurrent baseline writers across processes", async () => {
  await withFixture(async (root) => {
    const repository = new FilesystemArchitectureDecisionBaselineRepository();
    const current = await repository.read({
      consumerRoot: root,
      path: "architecture/decisions/accepted-decisions.json"
    });
    assert.equal(current.kind, "valid");
    if (current.kind !== "valid") {
      return;
    }

    const expected = { kind: "valid", revision: current.revision };
    const first = startConcurrentBaselineWriter({
      baseline: baselineWithDigest(current.value, "a"),
      consumerRoot: root,
      expected,
      path: "architecture/decisions/accepted-decisions.json"
    });
    const second = startConcurrentBaselineWriter({
      baseline: baselineWithDigest(current.value, "b"),
      consumerRoot: root,
      expected,
      path: "architecture/decisions/accepted-decisions.json"
    });

    await Promise.all([first.ready, second.ready]);
    first.child.stdin.end("go\n");
    second.child.stdin.end("go\n");

    const outcomes = [
      writerOutcome(await first.result),
      writerOutcome(await second.result)
    ];
    assert.deepEqual(
      outcomes.map((outcome) => outcome.kind).toSorted(),
      ["fulfilled", "rejected"]
    );
    assert.equal(
      outcomes.find((outcome) => outcome.kind === "rejected")?.code,
      "ARCHITECTURE_DECISION_BASELINE_WRITE_CONFLICT"
    );

    const persisted = JSON.parse(await readFile(baselinePath(root), "utf8"));
    assert.ok(
      ["a", "b"].some(
        (digestCharacter) =>
          persisted.decisions[0].immutableDigest ===
          `sha256:${digestCharacter.repeat(64)}`
      )
    );
  });
});

test("CLI keeps checks read-only and promotes only a declared ADR governance capability", async () => {
  await withFixture(async (root) => {
    await rm(baselinePath(root));
    await writeFoundationConfig(root);

    const check = spawnSync(
      process.execPath,
      [
        cliPath,
        "check",
        "governance.architecture-decisions",
        "--consumer",
        root,
        "--json"
      ],
      { encoding: "utf8" }
    );
    assert.equal(check.status, 1, check.stderr);
    await assert.rejects(readFile(baselinePath(root), "utf8"));

    const promotion = spawnSync(
      process.execPath,
      [
        cliPath,
        "architecture-decisions-promote-baseline",
        "--consumer",
        root,
        "--json"
      ],
      { encoding: "utf8" }
    );
    assert.equal(promotion.status, 0, promotion.stderr);
    assert.equal(JSON.parse(promotion.stdout).promotion.writeResult, "created");
    assert.deepEqual(await analyze(root), []);

    await rm(join(root, "foundation.config.yaml"));
    await writeFoundationConfig(root, false);
    const undeclared = spawnSync(
      process.execPath,
      [
        cliPath,
        "architecture-decisions-promote-baseline",
        "--consumer",
        root,
        "--json"
      ],
      { encoding: "utf8" }
    );
    assert.equal(undeclared.status, 2);
    assert.equal(undeclared.stderr, "");
    assert.equal(JSON.parse(undeclared.stdout).error.code, "CONSUMER_INVALID");
    assert.match(
      JSON.parse(undeclared.stdout).error.message,
      /^governance\.architecture-decisions must be declared/u
    );
  });
});
