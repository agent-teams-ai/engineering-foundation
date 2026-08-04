import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { planScaffoldFromFile } from "../packages/engineering-foundation/dist/scaffolding/index.js";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const fixtureRoot = join(
  repositoryRoot,
  "tests",
  "fixtures",
  "scaffolding-authority-consumer"
);

async function createConsumer() {
  const root = await mkdtemp(join(tmpdir(), "foundation-owner-resolution-"));
  await cp(fixtureRoot, root, { recursive: true });
  return root;
}

function plan(root) {
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

test("rejects malformed UTF-8 in every canonical authority source role", async () => {
  const sources = [
    {
      role: "config",
      repositoryPath: "architecture/foundation/scaffolding.yaml",
      path: configPath,
      malformedBytes: [0xc3, 0x28]
    },
    {
      role: "target-catalog",
      repositoryPath: "architecture/package-catalog.yaml",
      path: catalogPath,
      malformedBytes: [0xe2, 0x82]
    },
    {
      role: "owner-document",
      repositoryPath: "docs/decisions/adr-0060.md",
      path: ownerPath,
      malformedBytes: [0x80]
    }
  ];

  for (const source of sources) {
    const root = await createConsumer();
    try {
      const path = source.path(root);
      await writeFile(
        path,
        Buffer.concat([await readFile(path), Buffer.from(source.malformedBytes)])
      );
      await assert.rejects(plan(root), (error) => {
        assert.equal(error?.code, "SCAFFOLD_INPUT_INVALID", source.role);
        assert.match(error.message, /valid UTF-8/u, source.role);
        assert.ok(error.message.includes(source.repositoryPath), source.role);
        return true;
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("rejects missing, overlapping, and out-of-scope authority document roots", async () => {
  const scenarios = [
    {
      roots: "[missing-docs]",
      pattern: /Cannot index configured authority document roots/u
    },
    {
      roots: "[architecture]",
      pattern: /must resolve exactly once/u
    },
    {
      roots: "[docs, docs/decisions]",
      pattern: /cannot overlap/u
    },
    {
      roots: "[docs, docs-empty, docs/empty]",
      pattern: /cannot overlap/u
    }
  ];
  for (const scenario of scenarios) {
    const root = await createConsumer();
    try {
      await writeFile(
        configPath(root),
        (await readFile(configPath(root), "utf8")).replace(
          "documentRoots: [docs]",
          `documentRoots: ${scenario.roots}`
        ),
        "utf8"
      );
      await assert.rejects(plan(root), scenario.pattern);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("rejects the superseded duplicated owner-document catalog fields", async () => {
  const root = await createConsumer();
  try {
    await writeFile(
      catalogPath(root),
      (await readFile(catalogPath(root), "utf8")).replace(
        "owner_document: ADR-0060",
        [
          "owner_document_id: ADR-0060",
          "    owner_document_path: docs/decisions/adr-0060.md"
        ].join("\n")
      ),
      "utf8"
    );
    await assert.rejects(plan(root), /additional properties|required/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("bounds authority document traversal depth", async () => {
  const root = await createConsumer();
  try {
    await mkdir(join(root, "docs", ...Array.from({ length: 34 }, () => "d")), {
      recursive: true
    });
    await assert.rejects(plan(root), /cannot exceed 32 directory levels/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("bounds projected authority metadata before indexing", async () => {
  const scenarios = [
    ["id: ADR-0060", `id: ${"A".repeat(161)}`],
    ["status: accepted", `status: ${"a".repeat(161)}`]
  ];
  for (const [current, replacement] of scenarios) {
    const root = await createConsumer();
    try {
      await writeFile(
        ownerPath(root),
        (await readFile(ownerPath(root), "utf8")).replace(
          current,
          replacement
        ),
        "utf8"
      );
      await assert.rejects(plan(root), /normalized id and status strings/u);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("treats extra owner metadata as inert and validates the authority projection", async () => {
  const root = await createConsumer();
  try {
    await writeFile(
      ownerPath(root),
      (await readFile(ownerPath(root), "utf8")).replace(
        "status: accepted",
        "status: accepted\nrevoked: true"
      ),
      "utf8"
    );
    await assert.doesNotReject(plan(root));
    await writeFile(
      ownerPath(root),
      (await readFile(ownerPath(root), "utf8")).replace(
        "status: accepted",
        "status: [accepted]"
      ),
      "utf8"
    );
    await assert.rejects(plan(root), /normalized id and status strings/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
