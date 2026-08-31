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
} from "../dist/domain/profile-policy.js";
import { validatePortableRepositoryPath } from "../dist/index.js";
import { NodeDocsProfileReader } from "../dist/adapters/node-profile-reader.js";
import {
  discoverDocsProfilePath,
  PORTABLE_DOCS_PROFILE_PATH
} from "../dist/adapters/node-profile-discovery.js";

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
