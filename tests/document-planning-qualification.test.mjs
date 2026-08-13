import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  planDocumentationDocument,
} from "../packages/engineering-foundation/dist/document-authoring/index.js";
import {DocumentPlanningError} from "../packages/engineering-foundation/dist/document-authoring/document-planning-error.js";

const fixtures = fileURLToPath(
  new URL("fixtures/document-planning/", import.meta.url),
);

const planErrorCodes = new Set([
  "DOCUMENT_PLANNING_AUTHORITY_CHANGED",
  "DOCUMENT_PLANNING_AUTHORITY_UNAVAILABLE",
  "DOCUMENT_PLANNING_CATALOG_PARTIAL",
  "DOCUMENT_PLANNING_CONFLICT",
  "DOCUMENT_PLANNING_INPUT_INVALID",
  "DOCUMENT_PLANNING_OUTPUT_INVALID",
  "DOCUMENT_PLANNING_PARENT_UNAVAILABLE",
]);

const bytesFromPlan = (plan) => Buffer.from(plan.output.contentBase64, "base64");
const sha256 = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

async function withFixture(name, callback) {
  const root = await mkdtemp(join(tmpdir(), `foundation-document-plan-${name}-`));
  try {
    await cp(join(fixtures, name), root, {recursive: true});
    return await callback(root);
  } finally {
    await rm(root, {force: true, recursive: true});
  }
}

async function orchestratorCases() {
  return JSON.parse(
    await readFile(join(fixtures, "orchestrator", "cases.json"), "utf8"),
  );
}

async function compile(root, intent, profilePath = "document-authoring.yaml") {
  return planDocumentationDocument({consumerRoot: root, profilePath, intent});
}

function assertPlanningError(error, expectedCodes) {
  assert.ok(error instanceof DocumentPlanningError, error?.stack ?? String(error));
  assert.ok(planErrorCodes.has(error.code), error.code);
  assert.ok(expectedCodes.includes(error.code), `${error.code} not in ${expectedCodes.join(", ")}`);
  return true;
}

async function snapshotTree(root) {
  const entries = [];
  async function visit(relative) {
    const absolute = relative === "" ? root : join(root, relative);
    const names = await readdir(absolute);
    names.sort((left, right) => Buffer.from(left).compare(Buffer.from(right)));
    for (const name of names) {
      const path = relative === "" ? name : `${relative}/${name}`;
      const stat = await lstat(join(root, path));
      const mode = stat.mode & 0o7777;
      if (stat.isDirectory()) {
        entries.push({path, kind: "directory", mode});
        await visit(path);
      } else if (stat.isFile()) {
        const bytes = await readFile(join(root, path));
        entries.push({path, kind: "file", mode, bytes: bytes.toString("base64")});
      } else if (stat.isSymbolicLink()) {
        entries.push({path, kind: "symlink", mode});
      } else {
        entries.push({path, kind: "special", mode});
      }
    }
  }
  await visit("");
  return entries;
}

test("compiles all six static donor vectors twice to exact canonical bytes", async () => {
  const manifest = await orchestratorCases();
  await withFixture("orchestrator", async (root) => {
    for (const vector of manifest.cases) {
      const expected = await readFile(join(root, vector.expected));
      const first = await compile(root, vector.intent, manifest.profilePath);
      const second = await compile(root, vector.intent, manifest.profilePath);
      assert.deepEqual(first, second, vector.name);
      assert.deepEqual(bytesFromPlan(first), expected, vector.name);
      assert.equal(first.destination, vector.destination, vector.name);
      assert.equal(first.output.digest, sha256(expected), vector.name);
      assert.equal(first.output.size, expected.byteLength, vector.name);
      assert.equal(expected.includes(Buffer.from("\r")), false, vector.name);
      assert.equal(expected.at(-1), 0x0a, vector.name);
    }
  });
});

test("normalizes semantic Intent permutations without authority-byte tricks", async () => {
  const {cases} = await orchestratorCases();
  const vector = cases.find(({name}) => name === "feature");
  assert.ok(vector);
  await withFixture("orchestrator", async (root) => {
    const permuted = {
      additionalMetadata: {
        blocked_by: ["OD-001"],
        code_anchors: [{enforcement: "required", pattern: "packages/example/src/features/create-widget/*.ts"}],
      },
      related: ["ADR-0001", "OD-001"],
      destination: vector.intent.destination,
      summary: vector.intent.summary,
      owner: vector.intent.owner,
      title: vector.intent.title,
      id: vector.intent.id,
      type: vector.intent.type,
      schemaVersion: 1,
    };
    assert.deepEqual(await compile(root, vector.intent), await compile(root, permuted));
  });
});

test("normalizes a CRLF template to the same LF Plan output", async () => {
  const {cases} = await orchestratorCases();
  const vector = cases.find(({name}) => name === "adr");
  assert.ok(vector);
  await withFixture("orchestrator", async (root) => {
    const templatePath = join(root, "docs/templates/adr.md");
    const lf = await readFile(templatePath, "utf8");
    const lfPlan = await compile(root, vector.intent);
    await writeFile(templatePath, lf.replaceAll("\n", "\r\n"), "utf8");
    const crlfPlan = await compile(root, vector.intent);
    assert.deepEqual(bytesFromPlan(crlfPlan), bytesFromPlan(lfPlan));
    assert.equal(bytesFromPlan(crlfPlan).includes(Buffer.from("\r")), false);
  });
});

test("derives Unicode slugs and requires an explicit fallback for an empty derivation", async () => {
  const base = {
    schemaVersion: 1,
    type: "contract",
    id: "contract.example.unicode",
    owner: "architecture/tooling",
    summary: "Unicode filename qualification.",
  };
  await withFixture("orchestrator", async (root) => {
    const decomposedTitle = "Cre\u0300me bru\u0302le\u0301e de\u0301ja\u0300 vu";
    const derived = await compile(root, {...base, title: decomposedTitle});
    assert.equal(derived.destination, "docs/contracts/creme-brulee-deja-vu.md");
    assert.equal(derived.intent.title, decomposedTitle.normalize("NFC"));
    await assert.rejects(
      compile(root, {...base, id: "contract.example.empty", title: "中文"}),
      (error) => assertPlanningError(error, ["DOCUMENT_PLANNING_INPUT_INVALID"]),
    );
    const fallback = await compile(root, {
      ...base,
      id: "contract.example.fallback",
      title: "中文",
      slug: "explicit-fallback",
    });
    assert.equal(fallback.destination, "docs/contracts/explicit-fallback.md");
  });
});

test("rejects missing parents, duplicate relations, unsupported types, and partial catalogs", async () => {
  const {cases} = await orchestratorCases();
  const adr = cases.find(({name}) => name === "adr");
  const feature = cases.find(({name}) => name === "feature");
  assert.ok(adr && feature);
  await withFixture("orchestrator", async (root) => {
    await rm(join(root, dirname(adr.destination)), {recursive: true});
    await assert.rejects(
      compile(root, adr.intent),
      (error) => assertPlanningError(error, ["DOCUMENT_PLANNING_PARENT_UNAVAILABLE"]),
    );
  });
  await withFixture("orchestrator", async (root) => {
    await assert.rejects(
      compile(root, {...feature.intent, related: ["ADR-0001", "ADR-0001"]}),
      (error) => assertPlanningError(error, ["DOCUMENT_PLANNING_INPUT_INVALID"]),
    );
    await assert.rejects(
      compile(root, {...feature.intent, related: ["cafe\u0301", "café"]}),
      (error) => assertPlanningError(error, ["DOCUMENT_PLANNING_INPUT_INVALID"]),
    );
    await assert.rejects(
      compile(root, {...adr.intent, type: "unknown"}),
      (error) => assertPlanningError(error, ["DOCUMENT_PLANNING_INPUT_INVALID"]),
    );
    await writeFile(join(root, "docs/existing/broken.md"), "not governed markdown\n", "utf8");
    await assert.rejects(
      compile(root, adr.intent),
      (error) => assertPlanningError(error, ["DOCUMENT_PLANNING_CATALOG_PARTIAL"]),
    );
  });
});

test("admits only exact logical self and rejects false-self, ID, and path collisions", async () => {
  const {cases} = await orchestratorCases();
  const vector = cases.find(({name}) => name === "adr");
  assert.ok(vector);
  await withFixture("orchestrator", async (root) => {
    const planned = await compile(root, vector.intent);
    await writeFile(join(root, vector.destination), bytesFromPlan(planned));
    assert.deepEqual(await compile(root, vector.intent), planned);
  });
  await withFixture("orchestrator", async (root) => {
    await writeFile(join(root, vector.destination), "third-party collision\n", "utf8");
    await assert.rejects(
      compile(root, vector.intent),
      (error) => assertPlanningError(error, ["DOCUMENT_PLANNING_CONFLICT", "DOCUMENT_PLANNING_CATALOG_PARTIAL"]),
    );
  });
  await withFixture("orchestrator", async (root) => {
    const expected = await readFile(join(root, vector.expected));
    await writeFile(join(root, "docs/existing/same-id.md"), expected);
    await assert.rejects(
      compile(root, vector.intent),
      (error) => assertPlanningError(error, ["DOCUMENT_PLANNING_CONFLICT", "DOCUMENT_PLANNING_CATALOG_PARTIAL"]),
    );
  });
  await withFixture("orchestrator", async (root) => {
    await writeFile(join(root, "docs/decisions/9001-FROZEN-ADR.md"), "collision\n", "utf8");
    await assert.rejects(
      compile(root, vector.intent),
      (error) => assertPlanningError(error, ["DOCUMENT_PLANNING_CONFLICT", "DOCUMENT_PLANNING_CATALOG_PARTIAL"]),
    );
  });
});

test("rejects directory, symlink, FIFO, and case-alias destination states", async (t) => {
  const {cases} = await orchestratorCases();
  const vector = cases.find(({name}) => name === "runbook");
  assert.ok(vector);
  const scenarios = [
    ["directory", async (path) => mkdir(path)],
    ["symlink", async (path, root) => symlink(join(root, "docs/existing/adr-0001.md"), path)],
  ];
  if (process.platform !== "win32") {
    scenarios.push(["fifo", async (path) => {
      const result = spawnSync("mkfifo", [path]);
      assert.equal(result.status, 0, result.stderr?.toString());
    }]);
  }
  for (const [name, arrange] of scenarios) {
    await t.test(name, async () => withFixture("orchestrator", async (root) => {
      await arrange(join(root, vector.destination), root);
      await assert.rejects(
        compile(root, vector.intent),
        (error) => assertPlanningError(error, ["DOCUMENT_PLANNING_CATALOG_PARTIAL", "DOCUMENT_PLANNING_CONFLICT", "DOCUMENT_PLANNING_PARENT_UNAVAILABLE"]),
      );
    }));
  }
  await t.test("case alias", async () => withFixture("orchestrator", async (root) => {
    await writeFile(join(root, "docs/operations/FROZEN-WIDGET-OUTAGE.md"), "alias\n", "utf8");
    await assert.rejects(
      compile(root, vector.intent),
      (error) => assertPlanningError(error, ["DOCUMENT_PLANNING_CONFLICT", "DOCUMENT_PLANNING_CATALOG_PARTIAL"]),
    );
  }));
});

test("planning leaves every fixture name, byte, and mode unchanged", async () => {
  const {cases} = await orchestratorCases();
  const vector = cases.find(({name}) => name === "contract");
  assert.ok(vector);
  await withFixture("orchestrator", async (root) => {
    await chmod(join(root, "docs/existing/adr-0001.md"), 0o640);
    const before = await snapshotTree(root);
    await compile(root, vector.intent);
    const after = await snapshotTree(root);
    assert.deepEqual(after, before);
  });
});

test("compiles a heterogeneous profile without compiler customization", async () => {
  await withFixture("heterogeneous", async (root) => {
    const intent = {
      schemaVersion: 1,
      type: "playbook",
      id: "knowledge.playbooks.service.recovery",
      title: "Service Recovery",
      owner: "team/knowledge",
      summary: "Recover the service deterministically.",
      additionalMetadata: {labels: {zeta: "last", alpha: "first", middle: "middle"}},
    };
    const expected = await readFile(join(root, "expected/playbook.md"));
    const plan = await compile(root, intent);
    assert.equal(plan.destination, "handbook/content/service/recovery/README.md");
    assert.deepEqual(bytesFromPlan(plan), expected);
    assert.match(expected.toString("utf8"), /labels:\n  alpha: first\n  middle: middle\n  zeta: last/u);
  });
});
