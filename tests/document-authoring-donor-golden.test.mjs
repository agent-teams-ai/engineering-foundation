import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { Ajv2020 } from "ajv/dist/2020.js";
import { parse as parseYaml } from "yaml";

import {
  parseGovernedTemplateSkeleton,
  renderCanonicalDocument,
} from "../packages/document-authoring/dist/adapters/canonical-markdown.js";

const corpusRoot = fileURLToPath(
  new URL(
    "fixtures/document-authoring-contracts/orchestrator-golden-v1/",
    import.meta.url,
  ),
);
const manifest = JSON.parse(await readFile(join(corpusRoot, "manifest.json"), "utf8"));

const identityPatterns = {
  adr: /^ADR-[0-9]{4}$/,
  "open-decision": /^OD-[0-9]{3}$/,
  "bounded-context": /^domain\.contexts\.[a-z][a-z0-9-]*$/,
  contract: /^contract(?:\.[a-z][a-z0-9-]*){2,}$/,
  feature: /^feature(?:\.[a-z][a-z0-9-]*){2,}$/,
  runbook: /^runbook(?:\.[a-z][a-z0-9-]*){2,}$/,
};
const explicitSlugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

async function loadSchema(name) {
  return JSON.parse(
    await readFile(
      new URL(
        `../packages/document-authoring/schemas/${name}/v1.schema.json`,
        import.meta.url,
      ),
      "utf8",
    ),
  );
}

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function slugify(title) {
  return title
    .normalize("NFKD")
    .replaceAll(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-|-$/g, "");
}

function frontmatterKeys(source) {
  const lines = source.slice(4, source.indexOf("\n---\n", 4)).split("\n");
  return lines
    .filter((line) => /^[a-z][a-z0-9_]*:/.test(line))
    .map((line) => line.slice(0, line.indexOf(":")));
}

test("keeps the donor corpus self-contained and provenance-addressed", () => {
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.provenance.repository, "agent-teams-ai/Orchestrator");
  assert.equal(
    manifest.provenance.commit,
    "b9685a15552087cc8d83bfb8c4ce408231dcce70",
  );
  assert.equal(
    manifest.provenance.sourceManifestSha256,
    "b65ccc4b45d4baf91f8bc3e3ea07ede901f0368be614ca60cd07c13caf38aea5",
  );
  assert.equal(dirname(manifest.provenance.sourceManifest), "scripts/docs/fixtures");
  assert.match(manifest.provenance.semantics, /do not execute or import/);
  assert.match(manifest.provenance.semantics, /Five outputs retain exact parity/);
});

for (const goldenCase of manifest.cases) {
  test(`freezes donor ${goldenCase.name} path, LF/CRLF bytes, and frontmatter order`, async () => {
    const lf = await readFile(join(corpusRoot, goldenCase.sourceFixture));
    assert.equal(lf.byteLength, goldenCase.lf.size);
    assert.equal(digest(lf), goldenCase.lf.sha256);
    assert.equal(lf.includes(Buffer.from("\r\n")), false);
    assert.equal(lf.at(-1), 0x0a);

    const source = lf.toString("utf8");
    assert.deepEqual(frontmatterKeys(source), goldenCase.frontmatterKeys);
    assert.match(source, new RegExp(`^id: ${goldenCase.id}$`, "m"));
    assert.match(source, new RegExp(`^type: ${goldenCase.type}$`, "m"));

    const crlf = Buffer.from(source.replaceAll("\n", "\r\n"));
    assert.equal(crlf.byteLength, goldenCase.crlf.size);
    assert.equal(digest(crlf), goldenCase.crlf.sha256);
    assert.equal(Buffer.from(crlf.toString("utf8").replaceAll("\r\n", "\n")).equals(lf), true);
  });
}

test("freezes exact donor ID grammars", () => {
  for (const vector of manifest.identityVectors.valid) {
    assert.match(vector.id, identityPatterns[vector.type]);
  }
  for (const vector of manifest.identityVectors.invalid) {
    assert.doesNotMatch(vector.id, identityPatterns[vector.type]);
  }
});

test("normalizes donor policy into closed identity and placement strategies", () => {
  const policies = Object.fromEntries(
    manifest.normalizedPolicyVectors.map((policy) => [policy.type, policy]),
  );
  assert.deepEqual(policies["bounded-context"].identity, {
    kind: "qualified",
    prefixSegments: ["domain", "contexts"],
    minSuffixSegments: 1,
    maxSuffixSegments: 1,
  });
  assert.deepEqual(policies["bounded-context"].placement, {
    kind: "qualified-leaf-index",
    root: "docs/domain/contexts",
    requiredBasename: "README.md",
  });
  for (const type of ["contract", "feature", "runbook"]) {
    assert.equal(policies[type].identity.minSuffixSegments, 2);
    assert.equal(policies[type].identity.maxSuffixSegments, 16);
  }
  assert.deepEqual(policies.feature.placement, {
    kind: "explicit",
    allowedRoots: ["apps", "packages", "tooling"],
    requiredSegmentsInOrder: ["src", "features"],
    requiredBasename: "README.md",
    minimumSegmentsBeforeRequired: 1,
    minimumSegmentsAfterRequired: 1,
  });
});

test("validates the six-type donor profile through the public wire schema", async () => {
  const validate = new Ajv2020({ allErrors: true, strict: true }).compile(
    await loadSchema("document-authoring-profile"),
  );
  const artifactTypes = manifest.normalizedPolicyVectors.map((policy) => ({
    type: policy.type,
    initialStatus: "proposed",
    identity: policy.identity.kind === "qualified"
      ? {
          kind: "explicit",
          format: "qualified",
          grammar: {
            prefixSegments: policy.identity.prefixSegments,
            minSuffixSegments: policy.identity.minSuffixSegments,
            maxSuffixSegments: policy.identity.maxSuffixSegments,
          },
        }
      : policy.identity,
    placement: policy.placement,
    template: {
      kind: "fenced-markdown-body",
      path: `docs/templates/${policy.type}.md`,
    },
    heading: {
      kind: policy.type === "adr" || policy.type === "open-decision"
        ? "id-colon-title"
        : "title",
    },
    reachability: { kind: "not-required" },
  }));
  const profile = {
    schemaVersion: 1,
    projectId: "orchestrator-donor",
    catalog: {
      metadataSchemaPath: "docs/metadata.schema.json",
      ownerCatalog: { path: "docs/owners.yaml", contract: "foundation.owner-map/v1" },
      collections: [{ kind: "markdown-tree", root: "docs" }],
      excludedPrefixes: [],
    },
    authoring: { mode: "create-only", artifactTypes },
  };
  assert.equal(validate(profile), true, JSON.stringify(validate.errors));
});

test("enforces slug and destination presence for all six donor placements", async () => {
  const validate = new Ajv2020({ allErrors: true, strict: true }).compile(
    await loadSchema("document-intent"),
  );
  for (const goldenCase of manifest.cases) {
    const placement = manifest.normalizedPolicyVectors.find(
      (policy) => policy.type === goldenCase.type,
    ).placement.kind;
    const base = {
      schemaVersion: 1,
      type: goldenCase.type,
      id: goldenCase.id,
      title: goldenCase.title,
      owner: "architecture/tooling",
      summary: "Public wire presence vector.",
    };
    const intent = placement === "explicit"
      ? { ...base, destination: goldenCase.path }
      : { ...base, slug: goldenCase.slug };
    assert.equal(validate(intent), true, `${goldenCase.type}: ${JSON.stringify(validate.errors)}`);
    assert.equal(validate({ ...base, slug: goldenCase.slug, destination: goldenCase.path }), true);
  }
});

test("renders all six donor documents through the production canonical adapter", async () => {
  for (const goldenCase of manifest.cases) {
    const raw = await readFile(join(corpusRoot, goldenCase.sourceFixture), "utf8");
    const frontmatterEnd = raw.indexOf("\n---\n", 4);
    const frontmatter = parseYaml(raw.slice(4, frontmatterEnd));
    const headingMatch = /^# (?<heading>[^\n]+)$/mu.exec(raw.slice(frontmatterEnd + 5));
    assert.ok(headingMatch?.groups?.heading);
    const {
      id,
      type,
      status,
      owner,
      summary,
      related,
      ...additionalMetadata
    } = frontmatter;
    const template = parseGovernedTemplateSkeleton(`\`\`\`\`markdown\n${raw.trimEnd()}\n\`\`\`\`\n`);
    const rendered = renderCanonicalDocument({
      frontmatter: {
        id,
        type,
        status,
        owner,
        summary,
        ...(related === undefined ? {} : { related }),
        ...(Object.keys(additionalMetadata).length === 0 ? {} : { additionalMetadata }),
      },
      heading: headingMatch.groups.heading,
      template,
    });
    if (goldenCase.type === "feature") {
      assert.notEqual(rendered, raw);
      assert.deepEqual(
        parseYaml(rendered.slice(4, rendered.indexOf("\n---\n", 4))),
        frontmatter,
      );
      assert.match(rendered, /  - enforcement: required\n    pattern:/u);
    } else {
      assert.equal(rendered, raw, goldenCase.type);
    }
  }
});

test("freezes custom NFKD filename slug semantics including empty Unicode results", () => {
  for (const vector of manifest.slugVectors) {
    assert.equal(slugify(vector.title), vector.slug, vector.title);
  }
  for (const slug of manifest.explicitSlugVectors.valid) {
    assert.match(slug, explicitSlugPattern);
  }
  for (const slug of manifest.explicitSlugVectors.invalid) {
    assert.doesNotMatch(slug, explicitSlugPattern);
  }
});

test("freezes donor path projection for all six artifact types", () => {
  const paths = Object.fromEntries(
    manifest.cases.map((goldenCase) => [goldenCase.name, goldenCase.path]),
  );
  assert.deepEqual(paths, {
    adr: "docs/decisions/9001-frozen-adr.md",
    "open-decision": "docs/open-decisions/OD-901-frozen-choice.md",
    "bounded-context": "docs/domain/contexts/frozen/README.md",
    contract: "docs/contracts/frozen-widgets-v1.md",
    feature: "packages/example/src/features/create-widget/README.md",
    runbook: "docs/operations/frozen-widget-outage.md",
  });
});
