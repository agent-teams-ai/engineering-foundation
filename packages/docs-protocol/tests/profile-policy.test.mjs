import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { link, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  DocsProfileError,
  parseDocsProtocolProfile,
  projectReachability
} from "../dist/features/portable-documentation/application/profile-policy.js";
import { validatePortableRepositoryPath } from "../dist/index.js";
import { NodeDocsProfileReader } from "../dist/features/portable-documentation/adapters/outbound/node-profile-reader.js";
import {
  discoverDocsProfilePath,
  PORTABLE_DOCS_PROFILE_PATH
} from "../dist/features/docs-command/adapters/outbound/node-profile-discovery.js";

const fixture = new URL("./fixtures/valid-profile.yaml", import.meta.url);
const execute = promisify(execFile);

const profileObject = {
  schemaVersion: 3,
  protocol: { id: "agent-teams.docs-protocol", version: 1 },
  foundationProfile: { path: ".docs-protocol/document-authoring.yaml", schemaVersion: 3, metadataSidecarPolicy: "foundation-profile-v3-strict-merge" },
  agentWorkflow: { adoption: "portable-v1", skillPath: ".agents/skills/docs-authoring/SKILL.md" },
  semanticValidatorIds: ["documentation.domain-semantics"]
};

test("profile is data-only, versioned, and binary-normalized", async () => {
  const profile = parseDocsProtocolProfile(profileObject);
  assert.equal(profile.foundationProfile.schemaVersion, 3);
  assert.equal(profile.foundationProfile.metadataSidecarPolicy, "foundation-profile-v3-strict-merge");
  assert.deepEqual(profile.semanticValidatorIds, ["documentation.domain-semantics"]);
});

test("frozen original v3 parser outputs and diagnostics remain unchanged", async () => {
  const cases = JSON.parse(await readFile(new URL("./fixtures/profile-v3-frozen/parse-cases.json", import.meta.url), "utf8"));
  for (const entry of cases) {
    if (entry.error) {
      assert.throws(() => parseDocsProtocolProfile(entry.input), entry.error, entry.name);
    } else {
      assert.deepEqual(parseDocsProtocolProfile(entry.input), entry.output, entry.name);
      assert.equal(JSON.stringify(parseDocsProtocolProfile(entry.input)), JSON.stringify(entry.output), entry.name);
    }
  }
  assert.deepEqual(
    await readFile(new URL("../schemas/docs-protocol-profile/v3.schema.json", import.meta.url)),
    await readFile(new URL("./fixtures/profile-v3-frozen/v3.schema.json", import.meta.url))
  );
});

test("v4 rejects trailing-dot paths while the v3 path contract stays frozen", () => {
  const path = "docs./profile.yaml";
  assert.equal(validatePortableRepositoryPath(path), path);
  assert.throws(() => parseDocsProtocolProfile({
    ...profileObject, schemaVersion: 4,
    foundationProfile: { ...profileObject.foundationProfile, path },
    relations: { blockers: { types: ["task"], statuses: ["todo"], subjectIncompatibleStatuses: ["done"] } }
  }), DocsProfileError);
});

test("public portable repository path validator enforces canonical cross-platform paths", () => {
  assert.equal(validatePortableRepositoryPath("architecture/foundation/docs-protocol.yaml"), "architecture/foundation/docs-protocol.yaml");
  for (const path of [
    "/absolute.yaml",
    "docs\\profile.yaml",
    "a/../profile.yaml",
    "a/./profile.yaml",
    `${"a".repeat(256)}/profile.yaml`,
    "e\u0301/profile.yaml",
    "a".repeat(513)
  ]) {
    assert.throws(() => validatePortableRepositoryPath(path), DocsProfileError);
  }
});

test("portable profile v4 rejects Windows device aliases and carries data-only relation vocabulary", () => {
  const v4 = {
    ...profileObject,
    schemaVersion: 4,
    relations: { blockers: { types: ["task"], statuses: ["todo"], subjectIncompatibleStatuses: ["done"] } }
  };
  assert.deepEqual(parseDocsProtocolProfile(v4).relations.blockers, {
    types: ["task"], statuses: ["todo"], subjectIncompatibleStatuses: ["done"]
  });
  for (const path of ["CON/profile.yaml", "docs/aux.txt", "docs/LPT9./profile.yaml"]) {
    assert.throws(
      () => parseDocsProtocolProfile({ ...v4, foundationProfile: { ...v4.foundationProfile, path } }),
      /portable path policy/u
    );
  }
});

test("portable profile v3 selects only the closed portable adoption policy", () => {
  const portableProfile = profileObject;
  const profile = parseDocsProtocolProfile(portableProfile);
  assert.equal(profile.adoptionPolicy, "portable-v1");
  assert.equal(profile.agentWorkflow.adoption, "portable-v1");
  assert.throws(
    () => parseDocsProtocolProfile({
      ...portableProfile,
      agentWorkflow: { ...portableProfile.agentWorkflow, adoption: "load-plugin" }
    }),
    /portable-v1/u
  );
});

test("profile discovery selects only portable authority or an explicit override", async () => {
  const root = await mkdtemp(join(tmpdir(), "docs-protocol-discovery-"));
  try {
    assert.equal(await discoverDocsProfilePath({ consumerRoot: root }), PORTABLE_DOCS_PROFILE_PATH);
    await mkdir(join(root, "architecture", "foundation"), { recursive: true });
    await writeFile(join(root, "architecture/foundation/docs-protocol.yaml"), "legacy\n");
    assert.equal(await discoverDocsProfilePath({ consumerRoot: root }), PORTABLE_DOCS_PROFILE_PATH);
    assert.equal(
      await discoverDocsProfilePath({ consumerRoot: root, explicitProfilePath: "custom/docs.yaml" }),
      "custom/docs.yaml"
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("profile rejects executable keys and duplicated Foundation authority", () => {
  const source = structuredClone(profileObject);
  source.hooks = ["node scripts/docs.js"];
  assert.throws(() => parseDocsProtocolProfile(source), /must contain exactly/u);
  delete source.hooks;
  source.types = [{ type: "adr" }];
  assert.throws(() => parseDocsProtocolProfile(source), /must contain exactly/u);
});

test("colocated reachability emits the exact index and relative link", async () => {
  const feature = {
    type: "feature", initialStatus: "proposed", allowedOwnerIds: [], identity: { format: "qualified" },
    heading: { kind: "title" }, placement: { kind: "explicit", requiredSegmentsInOrder: ["src", "features"] }, requiredMetadata: [],
    reachability: { kind: "manual-colocated-index", pathPrefix: "before-required-segments", indexBasename: "README.md" }
  };
  assert.deepEqual(
    projectReachability(feature, "packages/runtime/src/features/session/README.md", "Session"),
    {
      state: "manual-required",
      indexPath: "packages/runtime/README.md",
      markdownLink: "[Session](src/features/session/README.md)"
    }
  );
});

test("node reader uses only a real contained disposable profile", async () => {
  const root = await mkdtemp(join(tmpdir(), "docs-protocol-profile-"));
  try {
    await mkdir(join(root, "docs"));
    await writeFile(join(root, "docs", "docs-protocol.yaml"), await readFile(fixture));
    const profile = await new NodeDocsProfileReader().read({ consumerRoot: root, profilePath: "docs/docs-protocol.yaml" });
    assert.equal(profile.foundationProfile.schemaVersion, 3);
    assert.equal(profile.adoptionPolicy, "portable-v1");
    await writeFile(join(root, "docs", "unknown-key.yaml"), `${await readFile(fixture, "utf8")}hooks: [unsafe]\n`);
    await assert.rejects(
      new NodeDocsProfileReader().read({ consumerRoot: root, profilePath: "docs/unknown-key.yaml" }),
      /does not match docs-protocol-profile\/v3/u
    );
    await assert.rejects(
      new NodeDocsProfileReader().read({ consumerRoot: root, profilePath: "../outside.json" }),
      /invalid/u
    );
    for (const profilePath of ["a/../docs/docs-protocol.yaml", "docs\\docs-protocol.yaml", "e\u0301/profile.yaml", "a".repeat(513)]) {
      await assert.rejects(
        new NodeDocsProfileReader().read({ consumerRoot: root, profilePath }),
        /invalid/u
      );
    }
    await link(join(root, "docs", "docs-protocol.yaml"), join(root, "docs", "hardlinked-profile.yaml"));
    await assert.rejects(
      new NodeDocsProfileReader().read({ consumerRoot: root, profilePath: "docs/hardlinked-profile.yaml" }),
      /hard links/u
    );
    await writeFile(join(root, "docs", "oversize.yaml"), Buffer.alloc(1_048_577, 0x20));
    await assert.rejects(
      new NodeDocsProfileReader().read({ consumerRoot: root, profilePath: "docs/oversize.yaml" }),
      /exceeds 1 MiB/u
    );
    const outside = await mkdtemp(join(tmpdir(), "docs-protocol-profile-outside-"));
    try {
      await writeFile(join(outside, "profile.yaml"), await readFile(fixture));
      await symlink(outside, join(root, "redirected"));
      await assert.rejects(
        new NodeDocsProfileReader().read({ consumerRoot: root, profilePath: "redirected/profile.yaml" }),
        /without symlinks/u
      );
      await symlink(join(outside, "profile.yaml"), join(root, "docs", "redirected-profile.yaml"));
      await assert.rejects(
        new NodeDocsProfileReader().read({ consumerRoot: root, profilePath: "docs/redirected-profile.yaml" }),
        /without symlinks/u
      );
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
    if (process.platform !== "win32") {
      const fifo = join(root, "docs", "profile.fifo");
      await execute("mkfifo", [fifo]);
      await assert.rejects(
        new NodeDocsProfileReader().read({ consumerRoot: root, profilePath: "docs/profile.fifo" }),
        /regular file/u
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("node reader accepts a Windows case alias for the same contained profile", {
  skip: process.platform !== "win32" && "Windows path semantics are required"
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "docs-protocol-profile-case-"));
  try {
    await mkdir(join(root, "CanonicalDocs"));
    await writeFile(join(root, "CanonicalDocs", "Profile.yaml"), await readFile(fixture));
    const profile = await new NodeDocsProfileReader().read({
      consumerRoot: root,
      profilePath: "canonicaldocs/profile.yaml"
    });
    assert.equal(profile.adoptionPolicy, "portable-v1");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("v4 wire schema and pure reader agree on bounded data-only vocabulary", async () => {
  const { Ajv2020 } = await import("ajv/dist/2020.js");
  const schema = JSON.parse(await readFile(new URL("../schemas/docs-protocol-profile/v4.schema.json", import.meta.url), "utf8"));
  const validate = new Ajv2020({ strict: true }).compile(schema);
  const valid = {
    ...profileObject, schemaVersion: 4,
    relations: { blockers: { types: ["task", "issue"], statuses: ["todo", "open"], subjectIncompatibleStatuses: ["done"] } }
  };
  assert.equal(validate(valid), true);
  assert.deepEqual(parseDocsProtocolProfile(valid).relations.blockers.types, ["issue", "task"]);
  const invalid = [
    { ...valid, hooks: ["node run.js"] },
    { ...valid, schemaVersion: 3 },
    { ...valid, schemaVersion: 5 },
    { ...valid, relations: {} },
    { ...valid, relations: { ...valid.relations, hook: "execute" } }
  ];
  for (const field of ["types", "statuses", "subjectIncompatibleStatuses"]) {
    for (const value of [[], ["todo", "todo"], ["UPPER"], ["todo\n"], ["a".repeat(161)], [() => "hook"], "todo", Array.from({ length: 257 }, (_value, i) => `id-${i}`)]) {
      invalid.push({ ...valid, relations: { blockers: { ...valid.relations.blockers, [field]: value } } });
    }
  }
  for (const input of invalid) {
    assert.equal(validate(input), false);
    assert.throws(() => parseDocsProtocolProfile(input), DocsProfileError);
  }
  const maximum = { ...valid, relations: { blockers: { ...valid.relations.blockers, types: Array.from({ length: 256 }, (_value, i) => `type-${i}`) } } };
  assert.equal(validate(maximum), true);
  assert.equal(parseDocsProtocolProfile(maximum).relations.blockers.types.length, 256);
});

test("v4 portable path intersection matches lower-layer rules without tightening v3", async () => {
  const { Ajv2020 } = await import("ajv/dist/2020.js");
  const { portableRepositoryPathProblem } = await import("@agent-teams/repository-mutation");
  const { validatePortableRepositoryPathV2 } = await import("../dist/index.js");
  const schema = JSON.parse(await readFile(new URL("../schemas/docs-protocol-profile/v4.schema.json", import.meta.url), "utf8"));
  const validate = new Ajv2020({ strict: true }).compile(schema);
  const profile = { ...profileObject, schemaVersion: 4, relations: { blockers: { types: ["task"], statuses: ["todo"], subjectIncompatibleStatuses: ["done"] } } };
  const paths = ["CON.yaml", "docs/aUx.txt", "docs/LPT9./file", "com1/file", "docs./file", "docs/nul ", "docs/trailing.", "docs/file\n", "docs/COM10.yaml", "docs/console.yaml", "a".repeat(255), "a".repeat(256), "a/../b", "a+b/file", "é/file", "docs/profile.yaml"];
  for (const path of paths) {
    let legacyAccepted = true;
    try {validatePortableRepositoryPath(path);} catch {legacyAccepted = false;}
    const expected = legacyAccepted && portableRepositoryPathProblem(path) === undefined;
    if (expected) {assert.equal(validatePortableRepositoryPathV2(path), path);}
    else {assert.throws(() => validatePortableRepositoryPathV2(path), DocsProfileError);}
    for (const key of ["foundationProfile", "agentWorkflow"]) {
      const input = { ...profile, [key]: { ...profile[key], [key === "foundationProfile" ? "path" : "skillPath"]: path } };
      assert.equal(validate(input), expected, path);
      if (expected) {assert.equal(parseDocsProtocolProfile(input).schemaVersion, 4);}
      else {assert.throws(() => parseDocsProtocolProfile(input), DocsProfileError);}
    }
  }
});

test("v4 validates its selected profile path while a normal v3 tree remains readable", async () => {
  const root = await mkdtemp(join(tmpdir(), "docs-v4-profile-path-"));
  try {
    const profile = { ...profileObject, schemaVersion: 4, relations: { blockers: { types: ["task"], statuses: ["todo"], subjectIncompatibleStatuses: ["done"] } } };
    await writeFile(join(root, "docs.config.yaml"), JSON.stringify(profile));
    const reader = new NodeDocsProfileReader();
    assert.equal((await reader.read({ consumerRoot: root, profilePath: "docs.config.yaml" })).schemaVersion, 4);
    if (process.platform !== "win32") {
      await mkdir(join(root, "docs."));
      await writeFile(join(root, "docs./profile.yaml"), JSON.stringify(profile));
      await assert.rejects(reader.read({ consumerRoot: root, profilePath: "docs./profile.yaml" }), /portable path policy/u);
      await writeFile(join(root, "docs./profile.yaml"), JSON.stringify(profileObject));
      assert.equal((await reader.read({ consumerRoot: root, profilePath: "docs./profile.yaml" })).schemaVersion, 3);
    }
  } finally {await rm(root, { recursive: true, force: true });}
});
