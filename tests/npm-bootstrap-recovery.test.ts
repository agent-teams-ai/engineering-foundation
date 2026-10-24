import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { gunzipSync, gzipSync } from "node:zlib";
import { parse as parseYaml } from "yaml";
import {
  assertProviderPlaceholderArchive,
  qualifyRegistryHistory,
} from "../scripts/npm-registry-history.ts";
import { readRegistryBytes } from "../scripts/npm-registry-read.ts";
import {
  prepareExistingBootstrap,
  publishedBootstrapCommit,
} from "../scripts/npm-bootstrap-recovery.ts";
import {
  bootstrapPackageById,
  parseBootstrapCatalog,
  NPM_PACKAGE_BOOTSTRAP,
} from "../scripts/npm-package-bootstrap-catalog.mjs";
import {
  auditLivePackage,
  livePackageEvidence,
  waitForBootstrapAvailability,
} from "../scripts/npm-package-bootstrap-registry.mjs";
import { registryPackageMetadata } from "../scripts/release-publish.mjs";
import { assertProvenanceBinding } from "../scripts/npm-package-bootstrap-release-policy.mts";
import { verifiedProvenanceFromNpmAudit } from "../scripts/release-publish-ordered-runtime.mjs";
import {
  auditEvidence,
  artifactProvenance,
  stackToolchain,
  source,
} from "./support/release-publish-ordered-fixtures.mjs";

import {
  object,
  text,
  stageRecord,
  recoveryProfile,
  workflowRecord,
  step,
} from "./support/npm-bootstrap-recovery-fixtures.ts";

const fixture = new URL("./fixtures/npm-bootstrap-recovery/", import.meta.url);
const stageBytes = await readFile(new URL("provider-placeholder.tgz", fixture));
const archive = await readFile(new URL("stack-toolchain-0.0.0.tgz", fixture));
const stage = stageRecord(
  JSON.parse(await readFile(new URL("provider-placeholder.json", fixture), "utf8")),
);
const profile = recoveryProfile(bootstrapPackageById("stack-toolchain", { approved: true }));
const sri = (bytes: Buffer) => `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
const stageUrl = stage.dist.tarball;
const archiveUrl = "https://registry.npmjs.org/stack-toolchain/-/stack-toolchain-0.0.0.tgz";
const packument = () => ({
  versions: {
    "0.0.0-stage": structuredClone(stage),
    "0.0.0": {
      name: "stack-toolchain",
      version: "0.0.0",
      dist: { integrity: profile.approval.archiveIntegrity },
      optionalDependencies: { bun: "1.4.3", tsrs: "0.18.0-ts7.1.0-dev.20260929" },
    },
  },
  "dist-tags": { bootstrap: "0.0.0", latest: "0.0.0" },
});
function fetchRegistry(metadata = packument()): typeof fetch {
  return async (input) => {
    const url = input instanceof URL ? input.href : typeof input === "string" ? input : input.url;
    if (url === stageUrl) {
      return new Response(stageBytes);
    }
    if (url === archiveUrl) {
      return new Response(archive);
    }
    return new Response(JSON.stringify(metadata));
  };
}

void test("bootstrap and ordinary release qualify the same pinned provider artifact before reducing history", async () => {
  const fetch = fetchRegistry();
  const bootstrap = await livePackageEvidence(profile, fetch);
  assert.ok(bootstrap);
  const ordered = await registryPackageMetadata({ name: profile.name }, fetch);
  assert.deepEqual(bootstrap.metadata.versions, ["0.0.0"]);
  assert.deepEqual(ordered.versions, ["0.0.0"]);
  assert.deepEqual(bootstrap.metadata.rawVersions, ["0.0.0", "0.0.0-stage"]);
  assert.deepEqual(ordered.providerPlaceholders, bootstrap.metadata.providerPlaceholders);
  assert.equal(bootstrap.metadata.providerPlaceholders[0].archiveIntegrity, sri(stageBytes));
});

void test("stub metadata, pinned bytes and tags all gate admission; extra versions remain visible", async () => {
  const mutations = [
    (p: ReturnType<typeof packument>) => {
      p.versions["0.0.0-stage"].stub = false;
    },
    (p: ReturnType<typeof packument>) => {
      p.versions["0.0.0-stage"].name = "foreign";
    },
    (p: ReturnType<typeof packument>) => {
      p.versions["0.0.0-stage"]["_id"] = "foreign@0.0.0-stage";
    },
    (p: ReturnType<typeof packument>) => {
      Object.assign(p.versions["0.0.0-stage"], { scripts: { install: "evil" } });
    },
    (p: ReturnType<typeof packument>) => {
      p["dist-tags"].latest = "0.0.0-stage";
    },
    (p: ReturnType<typeof packument>) => {
      p.versions["0.0.0-stage"].dist.integrity = sri(Buffer.from("other"));
    },
  ];
  for (const mutate of mutations) {
    const p = packument();
    mutate(p);
    await assert.rejects(qualifyRegistryHistory(p, profile, fetchRegistry(p)), /unqualified/u);
  }
  await assert.rejects(
    qualifyRegistryHistory(packument(), profile, async () => new Response("forged")),
    /unqualified/u,
  );
  const other = { ...packument(), versions: { ...packument().versions, "0.0.1-foreign": {} } };
  assert.deepEqual((await qualifyRegistryHistory(other, profile, fetchRegistry())).versions, [
    "0.0.0",
    "0.0.1-foreign",
  ]);
  assert.deepEqual(
    (await qualifyRegistryHistory(packument(), { name: profile.name }, fetchRegistry())).versions,
    ["0.0.0", "0.0.0-stage"],
  );
});

function tar(
  entries: { name: string; text?: string; type?: string }[],
  trailing = Buffer.alloc(0),
): Buffer {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const data = Buffer.from(entry.text ?? "");
    const header = Buffer.alloc(512);
    header.write(entry.name);
    header.write("0000644\0", 100);
    header.write("0000000\0", 108);
    header.write("0000000\0", 116);
    header.write(`${data.length.toString(8).padStart(11, "0")}\0`, 124);
    header.write("00000000000\0", 136);
    header.fill(32, 148, 156);
    header.write(entry.type ?? "0", 156);
    header.write("ustar\0", 257);
    header.write("00", 263);
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148);
    blocks.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  return gzipSync(Buffer.concat([...blocks, trailing]));
}

void test("even reviewed-SRI inputs cannot hide special, duplicate, extra, trailing or executable placeholder content", () => {
  const manifest = {
    name: profile.name,
    version: "0.0.0-stage",
    stub: true,
    description: "Temporary package placeholder for staged publishing",
  };
  const readme =
    "# Temporary Holding Version\n\nThis version is a temporary placeholder for this package. An operational version to replace this has been submitted for review and is awaiting a staged release.\n";
  const base = [
    { name: "package/package.json", text: JSON.stringify(manifest) },
    { name: "package/README.md", text: readme },
  ];
  assertProviderPlaceholderArchive(stageBytes, profile);
  const synthetic = tar(base);
  assertProviderPlaceholderArchive(synthetic, {
    name: profile.name,
    providerPlaceholder: { version: "0.0.0-stage", archiveIntegrity: sri(synthetic) },
  });
  const raw = gunzipSync(synthetic);
  const unsafe = [
    gzipSync(raw.subarray(0, raw.length - 512)),
    tar(base, Buffer.alloc(512)),
    tar([...base, base[0]]),
    tar([...base, { name: "package/evil.js", text: "evil" }]),
    tar([...base, { name: "package/link", type: "2" }]),
    tar(base, Buffer.from("hidden")),
    tar([
      { ...base[0], text: JSON.stringify({ ...manifest, scripts: { install: "evil" } }) },
      base[1],
    ]),
    tar([base[0], { ...base[1], text: "other" }]),
  ];
  for (const bytes of unsafe) {
    assert.throws(() => {
      assertProviderPlaceholderArchive(bytes, {
        name: profile.name,
        providerPlaceholder: { version: "0.0.0-stage", archiveIntegrity: sri(bytes) },
      });
    });
  }
});

void test("existing-only recovery downloads the approved archive; absence, drift or wrong original tree cannot become publication", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "TEST-existing-bootstrap-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const proof = await prepareExistingBootstrap(
    profile,
    profile.approval.packageTree,
    join(root, "good"),
    fetchRegistry(),
  );
  assert.equal(proof.integrity, sri(archive));
  assert.deepEqual(await readFile(proof.archivePath), archive);
  const retained = object(
    JSON.parse(await readFile(join(root, "good/existing-artifact.json"), "utf8")),
  );
  assert.equal(retained.sourceCommit, profile.recovery.sourceCommit);
  await assert.rejects(
    prepareExistingBootstrap(profile, "a".repeat(40), join(root, "bad"), fetchRegistry()),
    /original source tree/u,
  );
  await assert.rejects(
    prepareExistingBootstrap(
      profile,
      profile.approval.packageTree,
      join(root, "absent"),
      async () => new Response("", { status: 404 }),
    ),
    /publication is forbidden/u,
  );
  const drift = packument();
  drift.versions["0.0.0"].dist.integrity = sri(Buffer.from("drift"));
  await assert.rejects(
    prepareExistingBootstrap(
      profile,
      profile.approval.packageTree,
      join(root, "drift"),
      fetchRegistry(drift),
    ),
    /publication is forbidden/u,
  );
  assert.equal(publishedBootstrapCommit(profile, "b".repeat(40)), profile.recovery.sourceCommit);
  assert.throws(() => publishedBootstrapCommit(profile, "foreign"));
});

void test("Release Checks admits only its exact publication and qualifies scoped history without absent fallback", async (context) => {
  const recoveryCase = recoveryProfile(bootstrapPackageById("release-checks", { approved: true }));
  assert.deepEqual(recoveryCase.recovery, {
    sourceCommit: "dae3f6565698a0f9a1dff71c2aa8c3ff2e674a73",
    runId: 40079845789,
    runAttempt: 1,
  });
  for (const [key, replacement] of [
    ["id", "foreign"],
    ["name", "@agent-teams/foreign"],
    ["sourceCommit", "a".repeat(40)],
    ["runId", 40079845790],
    ["runAttempt", 2],
    ["archiveIntegrity", recoveryCase.approval.archiveIntegrity],
  ] as const) {
    const catalog = structuredClone(NPM_PACKAGE_BOOTSTRAP);
    const selected = object(
      catalog.packages.find((entry: unknown) => object(entry).id === recoveryCase.id),
    );
    const target = ["id", "name"].includes(key)
      ? selected
      : key === "archiveIntegrity"
        ? object(selected.providerPlaceholder)
        : object(selected.recovery);
    target[key] = replacement;
    assert.throws(() => parseBootstrapCatalog(catalog), /reviewed Stack or exact Release Checks/u);
  }
  const placeholder = await readFile(new URL("release-checks-provider-placeholder.tgz", fixture));
  const releaseArchive = await readFile(new URL("release-checks-0.0.0.tgz", fixture));
  const holdingVersion = stageRecord(
    JSON.parse(
      await readFile(new URL("release-checks-provider-placeholder.json", fixture), "utf8"),
    ),
  );
  const metadata = () => ({
    versions: {
      "0.0.0-stage": structuredClone(holdingVersion),
      "0.0.0": {
        name: recoveryCase.name,
        version: "0.0.0",
        dist: { integrity: recoveryCase.approval.archiveIntegrity },
      },
    } as Record<string, unknown>,
    "dist-tags": { bootstrap: "0.0.0", latest: "0.0.0" },
  });
  const fetchFor =
    (p = metadata(), bytes = releaseArchive, holding = placeholder): typeof fetch =>
    async (input) => {
      const url = input instanceof URL ? input.href : typeof input === "string" ? input : input.url;
      if (url === holdingVersion.dist.tarball) {
        return new Response(holding);
      }
      if (url.endsWith("/release-checks-0.0.0.tgz")) {
        return new Response(bytes);
      }
      return new Response(JSON.stringify(p));
    };
  const live = await livePackageEvidence(recoveryCase, fetchFor());
  const ordinary = await registryPackageMetadata({ name: recoveryCase.name }, fetchFor());
  assert.deepEqual(live?.metadata.versions, ["0.0.0"]);
  assert.deepEqual(ordinary.providerPlaceholders, live?.metadata.providerPlaceholders);
  const root = await mkdtemp(join(tmpdir(), "TEST-release-checks-existing-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const prepared = await prepareExistingBootstrap(
    recoveryCase,
    recoveryCase.approval.packageTree,
    join(root, "good"),
    fetchFor(),
  );
  assert.deepEqual(await readFile(prepared.archivePath), releaseArchive);
  const stageOnly = metadata();
  delete stageOnly.versions["0.0.0"];
  await assert.rejects(
    prepareExistingBootstrap(
      recoveryCase,
      recoveryCase.approval.packageTree,
      join(root, "absent"),
      fetchFor(stageOnly),
    ),
    /publication is forbidden/u,
  );
  await assert.rejects(
    prepareExistingBootstrap(
      recoveryCase,
      recoveryCase.approval.packageTree,
      join(root, "404"),
      async () => new Response("", { status: 404 }),
    ),
    /publication is forbidden/u,
  );
  await assert.rejects(
    prepareExistingBootstrap(
      recoveryCase,
      recoveryCase.approval.packageTree,
      join(root, "drift"),
      fetchFor(metadata(), Buffer.from("changed real archive")),
    ),
    /reviewed integrity/u,
  );
  const tagged = metadata();
  tagged["dist-tags"].latest = "0.0.0-stage";
  const foreign = metadata();
  object(foreign.versions["0.0.0-stage"])["_id"] = "foreign@0.0.0-holdingVersion";
  for (const p of [tagged, foreign]) {
    await assert.rejects(livePackageEvidence(recoveryCase, fetchFor(p)), /unqualified/u);
  }
  await assert.rejects(
    livePackageEvidence(
      recoveryCase,
      fetchFor(metadata(), releaseArchive, Buffer.from("changed holding archive")),
    ),
    /unqualified/u,
  );
  const extra = metadata();
  extra.versions["0.1.0-foreign"] = {};
  await assert.rejects(
    prepareExistingBootstrap(
      recoveryCase,
      recoveryCase.approval.packageTree,
      join(root, "extra"),
      fetchFor(extra),
    ),
    /publication is forbidden/u,
  );
});

void test("signed invocation is an optional added constraint with the old verified return shape unchanged", () => {
  for (const recoveryCase of [
    recoveryProfile(bootstrapPackageById("stack-toolchain")),
    recoveryProfile(bootstrapPackageById("release-checks")),
  ]) {
    const artifact = {
      ...stackToolchain,
      name: recoveryCase.name,
      version: "0.0.0",
      integrity: recoveryCase.approval.archiveIntegrity,
    };
    const provenance = artifactProvenance(artifact);
    provenance.commit = recoveryCase.recovery.sourceCommit;
    provenance.workflow = recoveryCase.provenance.workflowPath;
    const expectedSource = { ...source, workflow: recoveryCase.provenance.workflowPath };
    const evidence = auditEvidence(artifact, provenance);
    const verified = evidence.verified[0];
    const bundle = verified.attestationBundles[1].bundle!;
    const statement = object(
      JSON.parse(Buffer.from(bundle.dsseEnvelope.payload, "base64").toString()),
    );
    const invocation = `https://github.com/agent-teams-ai/engineering-foundation/actions/runs/${recoveryCase.recovery.runId}/attempts/${recoveryCase.recovery.runAttempt}`;
    object(statement.predicate).runDetails = { metadata: { invocationId: invocation } };
    bundle.dsseEnvelope.payload = Buffer.from(JSON.stringify(statement)).toString("base64");
    const original = verifiedProvenanceFromNpmAudit(evidence, artifact, expectedSource);
    assert.equal(
      assertProvenanceBinding({
        auditEvidence: evidence,
        expectedCommit: recoveryCase.recovery.sourceCommit,
        profile: recoveryCase,
      }),
      recoveryCase.recovery.sourceCommit,
    );
    assert.throws(
      () =>
        assertProvenanceBinding({
          auditEvidence: evidence,
          expectedCommit: "b".repeat(40),
          profile: recoveryCase,
        }),
      /closed publication authority/u,
    );
    assert.deepEqual(
      verifiedProvenanceFromNpmAudit(evidence, artifact, {
        ...expectedSource,
        expectedInvocation: invocation,
      }),
      original,
    );
    assert.throws(
      () =>
        verifiedProvenanceFromNpmAudit(evidence, artifact, {
          ...expectedSource,
          expectedInvocation: `${invocation}0`,
        }),
      /invocation/u,
    );
    const dependencies = object(object(statement.predicate).buildDefinition).resolvedDependencies;
    assert.ok(Array.isArray(dependencies));
    object(object(dependencies[0]).digest).gitCommit = "b".repeat(40);
    bundle.dsseEnvelope.payload = Buffer.from(JSON.stringify(statement)).toString("base64");
    assert.throws(
      () => assertProvenanceBinding({ auditEvidence: evidence, profile: recoveryCase }),
      /expected reviewed commit/u,
    );
    assert.equal(
      publishedBootstrapCommit(recoveryCase, "b".repeat(40)),
      recoveryCase.recovery.sourceCommit,
    );
  }
});

void test("availability waits past the former25s window and stops at an absolute deadline including a hung body", async () => {
  let now = 0;
  let reads = 0;
  await waitForBootstrapAvailability(profile, {
    now: () => now,
    wait: async (ms) => {
      now += ms;
    },
    fetchImplementation: async () => {
      reads += 1;
      return now < 60_000
        ? new Response("", { status: 404 })
        : new Response(
            JSON.stringify({
              name: profile.name,
              version: "0.0.0",
              dist: { integrity: profile.approval.archiveIntegrity },
            }),
          );
    },
  });
  assert.equal(now, 60_000);
  assert.equal(reads, 13);
  now = 0;
  await assert.rejects(
    waitForBootstrapAvailability(profile, {
      milliseconds: 15_000,
      now: () => now,
      wait: async (ms) => {
        now += ms;
      },
      fetchImplementation: async () => new Response("", { status: 404 }),
    }),
    /deadline/u,
  );
  assert.equal(now, 15_000);
  const hanging = new Response(new ReadableStream({ start() {} }));
  await assert.rejects(
    readRegistryBytes("https://registry.npmjs.org/example", async () => hanging, 20),
    /deadline/u,
  );
});

void test("availability diagnostics preserve only normalized HTTP, network and body outcomes", async () => {
  for (const kind of ["http", "network", "body"] as const) {
    let now = 0;
    const fetchImplementation: typeof fetch = async () => {
      if (kind === "http") {
        return new Response("private provider detail", { status: 503 });
      }
      if (kind === "body") {
        return new Response("private invalid JSON");
      }
      throw Object.assign(new Error("private transport detail"), { cause: { code: "ECONNRESET" } });
    };
    await assert.rejects(
      waitForBootstrapAvailability(profile, {
        milliseconds: 10,
        now: () => now,
        wait: async (ms) => {
          now += ms;
        },
        fetchImplementation,
      }),
      (error: unknown) => {
        const message = text(object(error).message);
        assert.match(message, /availability/u);
        assert.match(
          message,
          kind === "http" ? /HTTP_503/u : kind === "body" ? /REGISTRY_BAD_JSON/u : /ECONNRESET/u,
        );
        assert.doesNotMatch(message, /private/u);
        return true;
      },
    );
  }
  const hanging = new Response(new ReadableStream({ start() {} }));
  await assert.rejects(
    readRegistryBytes("https://registry.npmjs.org/example", async () => hanging, 20),
    (error: unknown) => {
      const record = object(error);
      assert.equal(record.code, "REGISTRY_READ_TIMEOUT");
      assert.equal(record.phase, "body");
      return true;
    },
  );
});

void test("audit refusal preserves install or audit phase, npm code and exit status without raw output", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "TEST-bootstrap-safe-failure-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  for (const phase of ["install", "audit"] as const) {
    await assert.rejects(
      auditLivePackage(profile, root, {
        attempts: 1,
        availability: async () => {},
        runNpm: async (args: string[]) => {
          if (args[0] === phase) {
            throw Object.assign(new Error("SECRET_RAW_PROVIDER"), {
              code: 1,
              stderr: "npm error code E404\nSECRET_RAW_PROVIDER",
              stdout: "SECRET_RAW_PROVIDER",
            });
          }
          return { stdout: "{}", stderr: "" };
        },
      }),
      (error: unknown) => {
        const message = text(object(error).message);
        assert.ok(message.includes(`"phase":"${phase}"`));
        assert.match(message, /"code":"E404"/u);
        assert.match(message, /"exitCode":1/u);
        assert.doesNotMatch(message, /SECRET_RAW_PROVIDER/u);
        return true;
      },
    );
  }
});

void test("catalog recovery identity stays closed and workflow preserves current execution vs original release authority", async () => {
  const historical = object(structuredClone(NPM_PACKAGE_BOOTSTRAP));
  const historyPackages = historical.packages;
  assert.ok(Array.isArray(historyPackages));
  object(historyPackages.find((p: unknown) => object(p).id === profile.id)).state = "historical";
  const historicalCatalog = parseBootstrapCatalog(historical);
  assert.throws(
    () => bootstrapPackageById(profile.id, { approved: true, catalog: historicalCatalog }),
    /not approved/u,
  );
  const value = object(structuredClone(NPM_PACKAGE_BOOTSTRAP));
  const packages = value.packages;
  assert.ok(Array.isArray(packages));
  const selected = object(packages.find((p: unknown) => object(p).id === profile.id));
  object(selected.recovery).runAttempt = 2;
  assert.throws(() => parseBootstrapCatalog(value), /reviewed Stack/u);
  const workflow = workflowRecord(
    parseYaml(
      await readFile(
        new URL("../.github/workflows/npm-package-bootstrap.yml", import.meta.url),
        "utf8",
      ),
    ),
  );
  const steps = workflow.jobs.bootstrap.steps;
  const pack = step(steps, "pack");
  const existing = step(steps, "existing");
  assert.match(pack.if ?? "", /publish-capable/u);
  assert.match(existing.if ?? "", /existing-artifact-only/u);
  assert.doesNotMatch(existing.run ?? "", /pnpm.*pack|npm publish/u);
  assert.match(existing.run ?? "", /git merge-base --is-ancestor/u);
  const mutation = steps.find(
    (s: { name?: string }) => s.name?.startsWith("Publish, resume") === true,
  );
  assert.match(
    mutation?.run ?? "",
    /BOOTSTRAP_MODE.*existing-artifact-only[\s\S]*REGISTRY_ACTION.*reuse[\s\S]*elif.*publish-capable/u,
  );
  assert.match(
    workflow.jobs["reconcile-github"].steps.find(
      (s: { run?: string }) => s.run?.includes("github-release-reconciliation.mjs") === true,
    )?.run ?? "",
    /true "\$\{PUBLISHED_COMMIT\}" "\$\{EXPECTED_COMMIT\}"/u,
  );
  const release = workflowRecord(
    parseYaml(await readFile(new URL("../.github/workflows/release.yml", import.meta.url), "utf8")),
  );
  const ordered = release.jobs.release.steps;
  assert.ok(
    ordered.findIndex((s: { name?: string }) => s.name === "Build the bootstrap archive verifier") <
      ordered.findIndex(
        (s: { name?: string }) => s.name === "Guard public package bootstrap baselines",
      ),
  );
});
