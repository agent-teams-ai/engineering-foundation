import assert from "node:assert/strict";
import test from "node:test";
import { sha256Bytes } from "../packages/engineering-foundation/dist/canonical-json.js";
import { PlanDocumentationDocument } from "../packages/engineering-foundation/dist/document-authoring/application/use-cases/plan-documentation-document.js";

const digest = (source) => sha256Bytes(new TextEncoder().encode(source));
const evidence = (path, source) => ({
  path,
  digest: digest(source),
  size: new TextEncoder().encode(source).byteLength
});

function fixture(overrides = {}) {
  const profileEvidence = evidence("architecture/foundation/document-authoring.yaml", "profile");
  const metadataEvidence = evidence("architecture/document-metadata.schema.json", "metadata");
  const ownerEvidence = evidence("architecture/owners.yaml", "owners");
  const templateEvidence = evidence("docs/templates/adr.md", "template");
  const intent = {
    schemaVersion: 1,
    type: "adr",
    id: "ADR-0083",
    title: "Deterministic planning",
    owner: "architecture/tooling",
    summary: "Plans exact governed documentation bytes."
  };
  const artifact = {
    type: "adr",
    initialStatus: "accepted",
    identity: { kind: "explicit", format: "adr-four-digits" },
    placement: {
      kind: "collection",
      directory: "docs/decisions",
      filename: "numeric-id-slug"
    },
    template: { kind: "fenced-markdown-body", path: templateEvidence.path },
    heading: { kind: "id-colon-title" }
  };
  const profile = {
    artifactTypes: [artifact],
    collections: [{ kind: "markdown-tree", root: "docs" }],
    evidence: profileEvidence,
    excludedPrefixes: ["node_modules"],
    metadataSchemaPath: metadataEvidence.path,
    ownerCatalog: { contract: "foundation.owner-map/v1", path: ownerEvidence.path },
    projectId: "fixture-project"
  };
  const catalog = {
    authority: {
      metadataSchema: metadataEvidence,
      ownerCatalog: ownerEvidence,
      profile: profileEvidence
    },
    diagnostics: [],
    documents: [],
    identityProjection: [],
    ownerIds: [intent.owner],
    projectId: profile.projectId,
    status: "complete"
  };
  const calls = [];
  let profileReads = 0;
  const dependencies = {
    catalog: {
      async execute() {
        calls.push("catalog");
        return catalog;
      }
    },
    compiler: {
      id: "@agent-teams/engineering-foundation",
      version: "0.14.0",
      buildIdentity: digest("build")
    },
    contracts: {
      async validateIntent(value) {
        calls.push("validate-intent");
        return value;
      },
      async validatePlan(value) {
        calls.push("validate-plan");
        return value;
      }
    },
    metadata: {
      async load() {
        calls.push("metadata");
        return {
          evidence: metadataEvidence,
          validate(value) {
            calls.push("validate-metadata");
            return { messages: [], valid: value.id === intent.id };
          }
        };
      }
    },
    owners: {
      async read() {
        calls.push("owners");
        return { evidence: ownerEvidence, ids: [intent.owner] };
      }
    },
    policies: {
      normalizeDocumentIntent(value) {
        calls.push("normalize");
        return Object.freeze({ ...value });
      },
      selectDocumentArtifact(value, type) {
        calls.push("select");
        return value.artifactTypes.find((candidate) => candidate.type === type);
      },
      resolveDocumentAuthoring({ artifact: selected, intent: value }) {
        calls.push("resolve");
        return {
          artifact: selected,
          destination: "docs/decisions/0083-deterministic-planning.md",
          heading: `${value.id}: ${value.title}`,
          slug: "deterministic-planning"
        };
      },
      isDestinationCoveredByCatalog() {
        calls.push("coverage");
        return true;
      },
      classifyDocumentLogicalPreimage(input) {
        calls.push("preimage");
        assert.equal(input.observedBytes, undefined);
        return { identityProjection: catalog.identityProjection, isExactSelf: false };
      }
    },
    profile: {
      async read() {
        calls.push("profile");
        profileReads += 1;
        return profile;
      }
    },
    renderer: {
      parseTemplate() {
        calls.push("parse-template");
        return { placeholderHeading: "Placeholder", body: "Body.\n" };
      },
      render(input) {
        calls.push("render");
        return `---\nid: ${input.frontmatter.id}\ntype: adr\nstatus: accepted\nowner: architecture/tooling\nsummary: Plans exact governed documentation bytes.\n---\n\n# ${input.heading}\n\nBody.\n`;
      }
    },
    state: {
      async observe() {
        calls.push("state");
        return {
          destination: { state: "absent" },
          expectedParent: {
            path: "docs/decisions",
            state: "directory",
            ancestry: "real-directories"
          }
        };
      }
    },
    templates: {
      async read() {
        calls.push("template");
        return { evidence: templateEvidence, source: "template" };
      }
    }
  };
  Object.assign(dependencies, overrides);
  return { calls, dependencies, intent, profileReads: () => profileReads };
}

test("plans exact bytes through read-only ports and recaptures every authority", async () => {
  const setup = fixture();
  const plan = await new PlanDocumentationDocument(setup.dependencies).execute({
    consumerRoot: "/disposable-fixture",
    profilePath: "architecture/foundation/document-authoring.yaml",
    intent: setup.intent
  });

  assert.equal(plan.destination, "docs/decisions/0083-deterministic-planning.md");
  assert.equal(plan.destinationPrecondition.state, "absent");
  assert.equal(plan.identityProjection.entryCount, 0);
  assert.equal(plan.selectedOwner.id, setup.intent.owner);
  assert.equal(plan.output.size, Buffer.from(plan.output.contentBase64, "base64").byteLength);
  assert.match(plan.planDigest, /^sha256:[0-9a-f]{64}$/u);
  assert.equal(setup.profileReads(), 2);
  assert.equal(setup.calls.filter((call) => call === "metadata").length, 2);
  assert.equal(setup.calls.filter((call) => call === "owners").length, 2);
  assert.equal(setup.calls.filter((call) => call === "template").length, 3);
  assert.equal(setup.calls.some((call) => /write|reserve|publish/u.test(call)), false);
});

test("fails closed when recaptured authority changes", async () => {
  const setup = fixture();
  let reads = 0;
  setup.dependencies.templates.read = async () => {
    reads += 1;
    return {
      evidence: evidence("docs/templates/adr.md", reads === 1 ? "template" : "changed"),
      source: "template"
    };
  };

  await assert.rejects(
    new PlanDocumentationDocument(setup.dependencies).execute({
      consumerRoot: "/disposable-fixture",
      profilePath: "architecture/foundation/document-authoring.yaml",
      intent: setup.intent
    }),
    (error) => error?.code === "DOCUMENT_PLANNING_AUTHORITY_CHANGED"
  );
});

test("fails closed when the final catalog or destination snapshot changes", async () => {
  const catalogSetup = fixture();
  let catalogReads = 0;
  const stableCatalog = await catalogSetup.dependencies.catalog.execute();
  catalogSetup.dependencies.catalog.execute = async () => {
    catalogReads += 1;
    return catalogReads === 1
      ? stableCatalog
      : { ...stableCatalog, identityProjection: [
          { id: "ADR-0099", repositoryPath: "docs/decisions/0099-race.md" }
        ] };
  };
  await assert.rejects(
    new PlanDocumentationDocument(catalogSetup.dependencies).execute({
      consumerRoot: "/disposable-fixture",
      profilePath: "architecture/foundation/document-authoring.yaml",
      intent: catalogSetup.intent
    }),
    (error) => error?.code === "DOCUMENT_PLANNING_AUTHORITY_CHANGED"
  );

  const stateSetup = fixture();
  let stateReads = 0;
  stateSetup.dependencies.state.observe = async () => {
    stateReads += 1;
    return {
      destination: stateReads === 1
        ? { state: "absent" }
        : { state: "regular-file", bytes: new TextEncoder().encode("raced") },
      expectedParent: {
        path: "docs/decisions",
        state: "directory",
        ancestry: "real-directories"
      }
    };
  };
  await assert.rejects(
    new PlanDocumentationDocument(stateSetup.dependencies).execute({
      consumerRoot: "/disposable-fixture",
      profilePath: "architecture/foundation/document-authoring.yaml",
      intent: stateSetup.intent
    }),
    (error) => error?.code === "DOCUMENT_PLANNING_AUTHORITY_CHANGED"
  );
});

test("admits decomposed catalog text but catches a third template read drift", async () => {
  const catalogSetup = fixture();
  const stableCatalog = await catalogSetup.dependencies.catalog.execute();
  catalogSetup.dependencies.catalog.execute = async () => ({
    ...stableCatalog,
    documents: [{
      id: "ADR-0001",
      owner: "architecture/tooling",
      repositoryPath: "docs/decisions/0001-neighbor.md",
      source: "markdown-tree",
      status: "accepted",
      summary: "Cafe\u0301 is valid catalog text.",
      title: "Cafe\u0301",
      type: "adr"
    }],
    identityProjection: [{
      id: "ADR-0001",
      repositoryPath: "docs/decisions/0001-neighbor.md"
    }]
  });
  await new PlanDocumentationDocument(catalogSetup.dependencies).execute({
    consumerRoot: "/disposable-fixture",
    profilePath: "architecture/foundation/document-authoring.yaml",
    intent: catalogSetup.intent
  });

  const templateSetup = fixture();
  let templateReads = 0;
  templateSetup.dependencies.templates.read = async () => {
    templateReads += 1;
    return {
      evidence: evidence(
        "docs/templates/adr.md",
        templateReads < 3 ? "template" : "changed-after-catalog"
      ),
      source: "template"
    };
  };
  await assert.rejects(
    new PlanDocumentationDocument(templateSetup.dependencies).execute({
      consumerRoot: "/disposable-fixture",
      profilePath: "architecture/foundation/document-authoring.yaml",
      intent: templateSetup.intent
    }),
    (error) => error?.code === "DOCUMENT_PLANNING_AUTHORITY_CHANGED"
  );
});

test("honors cancellation before dependency calls and before returning", async () => {
  const early = fixture();
  const earlyAbort = new AbortController();
  earlyAbort.abort();
  await assert.rejects(
    new PlanDocumentationDocument(early.dependencies).execute({
      consumerRoot: "/disposable-fixture",
      profilePath: "architecture/foundation/document-authoring.yaml",
      intent: early.intent,
      signal: earlyAbort.signal
    })
  );
  assert.deepEqual(early.calls, []);

  const late = fixture();
  const lateAbort = new AbortController();
  late.dependencies.contracts.validatePlan = async (plan) => {
    lateAbort.abort();
    return plan;
  };
  await assert.rejects(
    new PlanDocumentationDocument(late.dependencies).execute({
      consumerRoot: "/disposable-fixture",
      profilePath: "architecture/foundation/document-authoring.yaml",
      intent: late.intent,
      signal: lateAbort.signal
    })
  );
});

test("rejects a partial catalog before emitting a Plan", async () => {
  const setup = fixture();
  setup.dependencies.catalog.execute = async () => ({
    ...(await fixture().dependencies.catalog.execute()),
    status: "partial",
    diagnostics: [
      {
        message: "Malformed neighbor.",
        ruleId: "document.catalog.invalid",
        severity: "error",
        subject: "docs/bad.md"
      }
    ]
  });

  await assert.rejects(
    new PlanDocumentationDocument(setup.dependencies).execute({
      consumerRoot: "/disposable-fixture",
      profilePath: "architecture/foundation/document-authoring.yaml",
      intent: setup.intent
    }),
    (error) => error?.code === "DOCUMENT_PLANNING_CATALOG_PARTIAL"
  );
});

test("replays only a policy-proven exact logical self", async () => {
  const setup = fixture();
  let plannedBytes;
  setup.dependencies.renderer.render = (input) => {
    const output = `---\nid: ${input.frontmatter.id}\ntype: adr\nstatus: accepted\nowner: architecture/tooling\nsummary: Plans exact governed documentation bytes.\n---\n\n# ${input.heading}\n\nBody.\n`;
    plannedBytes = new TextEncoder().encode(output);
    return output;
  };
  setup.dependencies.state.observe = async () => ({
    destination: { state: "regular-file", bytes: plannedBytes },
    expectedParent: {
      path: "docs/decisions",
      state: "directory",
      ancestry: "real-directories"
    }
  });
  setup.dependencies.policies.classifyDocumentLogicalPreimage = (input) => {
    assert.deepEqual(input.observedBytes, input.expectedBytes);
    return { identityProjection: [], isExactSelf: true };
  };

  const plan = await new PlanDocumentationDocument(setup.dependencies).execute({
    consumerRoot: "/disposable-fixture",
    profilePath: "architecture/foundation/document-authoring.yaml",
    intent: setup.intent
  });
  assert.equal(plan.destinationPrecondition.state, "absent");
});

test("rejects regular files that policy does not prove as exact self", async () => {
  const setup = fixture();
  setup.dependencies.state.observe = async () => ({
    destination: { state: "regular-file", bytes: new TextEncoder().encode("different") },
    expectedParent: {
      path: "docs/decisions",
      state: "directory",
      ancestry: "real-directories"
    }
  });
  setup.dependencies.policies.classifyDocumentLogicalPreimage = () => ({
    identityProjection: [],
    isExactSelf: false
  });

  await assert.rejects(
    new PlanDocumentationDocument(setup.dependencies).execute({
      consumerRoot: "/disposable-fixture",
      profilePath: "architecture/foundation/document-authoring.yaml",
      intent: setup.intent
    }),
    (error) => error?.code === "DOCUMENT_PLANNING_CONFLICT"
  );
});
