import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { runNpmCommand, runCommand } from "./pack-test-support.mjs";
import { pathToFileURL } from "node:url";

const controlledNow = () => new Date("2026-09-20T12:00:00.000Z");

async function withinAuthorityDeadline(operation, input) {
  const started = performance.now();
  const result = await operation({ ...input, signal: AbortSignal.timeout(120_000) });
  assert.ok(performance.now() - started < 120_000, "Installed authority operation must meet the unchanged 120s deadline.");
  return result;
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") { return JSON.stringify(value); }
  if (Array.isArray(value)) { return `[${value.map(canonicalJson).join(",")}]`; }
  return `{${Object.entries(value).toSorted(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
}

const digest = value => `sha256:${createHash("sha256").update(canonicalJson(value), "utf8").digest("hex")}`;
const archiveIdentity = bytes => ({ archiveDigest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
  archiveIntegrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}` });
const compareCanonical = (left, right) => canonicalJson(left) < canonicalJson(right) ? -1 : canonicalJson(left) > canonicalJson(right) ? 1 : 0;

function canonicalCustody(files) {
  const sorted = files.toSorted((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const archivePayload = canonicalJson({ schemaVersion: "foundation:sdk-growth:archive:1", files: sorted });
  const archiveManifest = sorted.map(file => ({ path: file.path, digest: archiveIdentity(Buffer.from(file.contentHex, "hex")).archiveDigest }));
  return { ...archiveIdentity(archivePayload), archivePayload, archiveManifest, installedFiles: archiveManifest };
}

async function installedFiles(directory, prefix = "") {
  const output = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = `${prefix}${entry.name}`, path = join(directory, entry.name);
    if (entry.isDirectory()) { output.push(...await installedFiles(path, `${relative}/`)); }
    else if (entry.isFile()) { output.push({ path: relative, contentHex: (await readFile(path)).toString("hex") }); }
    else { throw new Error("Unexpected installed archive member."); }
  }
  return output.toSorted((left, right) => left.path.localeCompare(right.path));
}

function installedInventoryReader(installations) {
  return { async read(identity, cancellation) {
    cancellation.throwIfCancelled();
    const root = installations.get(identity.archiveDigest);
    if (!root) { throw new Error("Unknown installed custody identity."); }
    return (await installedFiles(root)).map(file => ({ path: file.path, bytes: Buffer.from(file.contentHex, "hex") }));
  } };
}

async function assertLegacyProtocolRejected(api, transport, repositoryRoot, binding) {
  const legacy = api.createSdkGrowthAuthorityVerifier({ ...transport, async resolve(request) {
    const grant = JSON.parse(await transport.resolve(request));
    return JSON.stringify({ ...grant, schemaVersion: "reviewrouter:sdk-growth-authority:1" });
  } }, undefined, controlledNow);
  let rejected = false;
  try { await withinAuthorityDeadline(legacy.qualifyCheck, { consumerRoot: repositoryRoot, configPath: "policy.yaml", binding }); }
  catch (error) { rejected = error?.reason === "growth-authority-grant-invalid"; }
  if (!rejected) { throw new Error("Packed authority did not explicitly reject protocol v1."); }
}

async function assertSuccessfulPackedPromotion(verifier, input, binding, qualified, race) {
  assert.equal(qualified.report.verdict, "admitted");
  assert.equal(qualified.report.releaseEligible, true);
  assert.equal(qualified.receipt.qualification, "qualified");
  const destinations = [input.config.packages[0].releasedBaselinePath,
    input.config.packages[0].releasedBaselinePath.replace(/\.json$/u, ".artifacts.json")];
  const before = await Promise.all(destinations.map(path => readFile(join(input.repositoryRoot, path))));
  const manifestPath = join(input.repositoryRoot, "package.json");
  const originalManifest = await readFile(manifestPath);
  let raceTriggered = false;
  race.mutate = async () => { raceTriggered = true; await writeFile(manifestPath, Buffer.concat([originalManifest, Buffer.from("\n")])); };
  try {
    await assert.rejects(withinAuthorityDeadline(verifier.promoteRelease, { consumerRoot: input.repositoryRoot, configPath: "policy.yaml", binding,
      admissionReceiptId: qualified.receipt.receiptId }), error => error?.reason === "growth-execution-inputs-changed"
        || (error?.problem?.code === "SDK_GROWTH_EVIDENCE_INCOMPLETE"
          && error.problem.message === "Source Git checkpoint is unavailable or changed."));
    assert.equal(raceTriggered, true, "The rejecting run must reach asynchronous promotion completion.");
    for (const [index, destination] of destinations.entries()) {
      assert.deepEqual(await readFile(join(input.repositoryRoot, destination)), before[index]);
    }
  } finally {
    race.mutate = undefined;
    await writeFile(manifestPath, originalManifest);
  }
  const promoted = await withinAuthorityDeadline(verifier.promoteRelease, { consumerRoot: input.repositoryRoot, configPath: "policy.yaml", binding,
    admissionReceiptId: qualified.receipt.receiptId });
  const writes = [], baselines = [];
  for (const [index, destination] of destinations.entries()) {
    const bytes = await readFile(join(input.repositoryRoot, destination));
    const snapshot = JSON.parse(bytes);
    assert.equal(snapshot.packageVersion, input.candidateVersion);
    assert.equal(snapshot.packageName, input.packageName);
    const expected = structuredClone(index === 0 ? input.expectedTyped : input.expectedArtifact);
    if (index === 0) {
      for (const entry of expected.entrypoints) { entry.items.sort((a, b) => a.canonicalReference < b.canonicalReference ? -1 : a.canonicalReference > b.canonicalReference ? 1 : 0); }
      assert.deepEqual(snapshot, expected);
    } else { assert.deepEqual(bytes, Buffer.from(`${JSON.stringify(expected, null, 2)}\n`)); }
    assert.notDeepEqual(bytes, before[index]);
    writes.push({ destination, operation: "replace", preimageDigest: archiveIdentity(before[index]).archiveDigest,
      proposedDigest: archiveIdentity(bytes).archiveDigest });
    baselines.push({ destination, contentHex: bytes.toString("hex"), digest: archiveIdentity(bytes).archiveDigest });
  }
  const plan = { binding, writes: writes.toSorted((a, b) => a.destination < b.destination ? -1 : 1) };
  assert.equal(promoted.receipt.operation, "promote-release");
  assert.equal(promoted.receipt.qualification, "qualified");
  assert.equal(promoted.receipt.reportDigest, qualified.receipt.reportDigest);
  assert.deepEqual(promoted.receipt.binding, binding);
  assert.deepEqual(promoted.receipt.promotion, { kind: "plan",
    planDigest: digest({ domain: "reviewrouter:sdk-growth-authority:promotion-plan:3", plan }) });
  assert.equal(archiveIdentity(await readFile(join(input.repositoryRoot, input.config.sdkGrowth.reportPath))).archiveDigest, qualified.receipt.reportDigest);
  return { admissionReceipt: qualified.receipt, receipt: promoted.receipt, plan, writes, baselines, raceRejectedWithoutWrites: raceTriggered };
}

/** A deliberately closed test observer: exact known bytes prove this fixture's
 * one declaration, one runtime export, no imports/bins, and one data member.
 * It never executes package code and makes no general archive-support claim. */
export async function observeClosedFixture(observation, archivePath) {
  const extracted = await mkdtemp(join(dirname(archivePath), "closed-observer-"));
  await runCommand("tar", ["-xzf", archivePath, "-C", extracted], extracted);
  const files = await installedFiles(join(extracted, "package"));
  const contents = new Map(files.map(row => [row.path, Buffer.from(row.contentHex, "hex").toString("utf8")]));
  const manifest = JSON.parse(contents.get("package.json"));
  assert.ok(["1.0.0", "1.1.0"].includes(manifest.version));
  const added = manifest.version === "1.1.0";
  assert.deepEqual(files.map(row => row.path), [...(added ? ["dist/data/extra.txt"] : []), "dist/data/fixture.txt", "dist/index.d.ts", "dist/index.js", "package.json"]);
  assert.equal(contents.get("dist/index.js"), "export function stable(value) { return value; }\n"
    + (added ? "export function added(value) { return value; }\n" : ""));
  assert.equal(contents.get("dist/index.d.ts"), "export declare function stable(value: string): string;\n"
    + (added ? "export declare function added(value: string): string;\n" : ""));
  assert.equal(contents.get("dist/data/fixture.txt"), "disposable packed artifact\n");
  if (added) { assert.equal(contents.get("dist/data/extra.txt"), "additional disposable artifact\n"); }
  assert.equal(manifest.bin, undefined);
  assert.equal(manifest.dependencies, undefined);
  assert.deepEqual(manifest.exports, { ".": { types: "./dist/index.d.ts", import: "./dist/index.js" }, "./data/*": "./dist/data/*" });
  const entries = observation.entries.filter(row => row.coordinate.packageName === manifest.name);
  for (const [exportPath, target] of Object.entries(manifest.exports)) {
    const tree = typeof target === "string" ? { kind: "target", target } : { kind: "conditions",
      entries: Object.entries(target).map(([condition, value]) => ({ condition, value: { kind: "target", target: value } })) };
    const branch = entries.find(row => row.coordinate.exportPath === exportPath && row.coordinate.subject.kind === "export-branch");
    assert.deepEqual(branch?.value, { state: "present", digest: digest(tree) }, "Archive export order must match its own observation.");
  }
  assert.equal(entries.filter(row => row.coordinate.subject.kind === "typed").length, added ? 2 : 1);
  assert.equal(entries.filter(row => row.coordinate.subject.kind === "wildcard-member").length, added ? 2 : 1);
  assert.equal(observation.coverage.filter(row => row.packageName === manifest.name).length, 1);
  return { ...observation, coverage: observation.coverage.map(row => row.packageName !== manifest.name ? row : ({ ...row, dimensions: row.dimensions.map(dimension => ({
    dimension: dimension.dimension, status: dimension.dimension === "decision" ? "unavailable" : "complete",
    reasons: [dimension.dimension === "decision" ? "s1-decision-evidence-unavailable" : "closed-fixture-byte-observation"]
  })) })) };
}

async function selectFixtureObservation(input, observation, archivePath) {
  return input.positivePromotion ? observeClosedFixture(observation, archivePath) : observation;
}

async function metadataRootEvidence(input) {
  const capture = async observation => {
    const read = async path => (await runCommand("git", ["show", `${observation.sourceCommit}:${path}`], input.repositoryRoot)).stdout;
    return { source: { commit: observation.sourceCommit, tree: observation.sourceTree },
      manifestBytes: await read("package.json"), workspaceBytes: await read("pnpm-workspace.yaml"),
      classificationBytes: await read("architecture/metadata-root.json") };
  };
  const evidence = { kind: "non-release-metadata-root", packageName: "sdk-fixture-root", rootPath: ".", manifestPath: "package.json",
    classificationPath: "architecture/metadata-root.json", historyDigest: digest("packed-history"),
    base: await capture(input.trustedBase), candidate: await capture(input.candidateObservation) };
  const evidenceDigest = digest({ domain: "foundation:sdk-growth:metadata-root:1", evidence });
  return { evidence, evidenceDigest, ownerEvidence: { decisionId: "ROOT-1", ownerRef: "fixture/sdk-owner", decisionDigest: evidenceDigest,
    authenticatedSubjectId: "packed-root-owner", authorizationEvidenceDigest: digest("packed-root-authorization"),
    approvalEvidenceDigest: digest("packed-root-approval"), sourceBindingDigest: digest("unbound") } };
}

function qualifyMetadataCoverage(observation, root) {
  assert.equal(observation.coverage.filter(row => row.packageName === root.evidence.packageName).length, 1);
  return { ...observation, coverage: observation.coverage.map(row => row.packageName !== root.evidence.packageName ? row : ({
    ...row, dimensions: row.dimensions.map(dimension => ({ dimension: dimension.dimension,
      status: dimension.dimension === "decision" ? "unavailable" : "complete",
      reasons: [dimension.dimension === "decision" ? "s1-decision-evidence-unavailable" : "qualified-non-release-metadata-root"] })) })) };
}

function expectedReportCoverage(base, candidate, admitted) {
  const rank = { complete: 0, limited: 1, unsupported: 2, unavailable: 3 };
  return candidate.coverage.map(row => ({ ...row, dimensions: row.dimensions.map(dimension => {
    if (dimension.dimension === "decision") { return { dimension: "decision", status: admitted ? "complete" : "unavailable",
      reasons: [admitted ? "growth-decision-set-evaluated" : "growth-owner-and-run-authority-unverified"] }; }
    const before = base.coverage.find(previous => previous.packageName === row.packageName).dimensions.find(previous => previous.dimension === dimension.dimension);
    return { dimension: dimension.dimension, status: rank[before.status] > rank[dimension.status] ? before.status : dimension.status,
      reasons: [...before.reasons.map(reason => `trusted-base:${reason}`), ...dimension.reasons.map(reason => `candidate:${reason}`)].toSorted() };
  }) }));
}

async function packedEvidence(archivePath, observation, packageName, installations) {
  observation = { ...observation,
    entries: observation.entries.filter(row => row.coordinate.packageName === packageName),
    coverage: observation.coverage.filter(row => row.packageName === packageName) };
  assert.equal(observation.coverage.length, 1);
  const bytes = await readFile(archivePath), transportArchive = archiveIdentity(bytes);
  const root = await mkdtemp(join(dirname(archivePath), "installed-custody-"));
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "packed-custody", private: true }));
  await runNpmCommand(["install", "--offline", "--ignore-scripts", "--no-audit", "--no-fund", "--cache", join(root, "npm-cache"), archivePath], root);
  const installedRoot = join(root, "node_modules", packageName);
  const manifest = JSON.parse(await readFile(join(installedRoot, "package.json")));
  if (manifest.name !== packageName) { throw new Error("Installed archive package identity mismatch."); }
  const lock = JSON.parse(await readFile(join(root, "package-lock.json")));
  if (lock.packages[`node_modules/${packageName}`].integrity !== transportArchive.archiveIntegrity) {
    throw new Error("Installed archive integrity mismatch.");
  }
  const source = { commit: observation.sourceCommit, tree: observation.sourceTree };
  const observationDigest = digest({ domain: "foundation:sdk-growth:observation:1", payload: observation });
  const extracted = await mkdtemp(join(dirname(archivePath), "archive-custody-"));
  await runCommand("tar", ["-xzf", archivePath, "-C", extracted], extracted);
  const custodyEvidence = canonicalCustody(await installedFiles(join(extracted, "package")));
  const { archiveDigest, archiveIntegrity } = custodyEvidence;
  installations.set(archiveDigest, installedRoot);
  const installedDistribution = { packageName, packageVersion: manifest.version, source, archiveDigest, archiveIntegrity, observationDigest };
  return { ...installedDistribution, observation, coverage: observation.coverage[0], custodyEvidence,
    custodyEvidenceDigest: digest({ domain: "foundation:sdk-growth:custody:1", payload: custodyEvidence }), installedDistribution };
}

/** Run the installed public authority entrypoint against the disposable packed
 * SDK repository assembled by pack-sdk-growth-test. Transport responses cross
 * the real serialized JSON boundary. */
export async function assertPackedSdkGrowthAuthorityExecution(input) {
  const requireFromConsumer = createRequire(join(input.installedConsumerRoot, "package.json"));
  const installedManifest = requireFromConsumer.resolve("@agent-teams/engineering-foundation/package.json");
  const manifest = JSON.parse(await readFile(installedManifest));
  const selected = manifest.exports?.["./sdk-growth-authority"];
  const target = typeof selected === "string" ? selected : selected?.import;
  if (typeof target !== "string" || !target.startsWith("./")) {
    throw new Error("Packed Foundation manifest does not select the SDK growth authority entrypoint.");
  }
  const entrypoint = join(dirname(installedManifest), target);
  const api = await import(pathToFileURL(entrypoint));
  const candidate = input.matchedReport.candidate.value;
  const rootEvidence = await metadataRootEvidence(input);
  const trustedBase = { ...qualifyMetadataCoverage(await selectFixtureObservation(input, input.trustedBase, input.releasedArchivePath), rootEvidence), repository: "github:123" };
  const baseReference = { ...input.baseReference,
    surfaceDigest: digest({ domain: "foundation:sdk-growth:observation:1", payload: trustedBase }) };
  const invocation = { repository: "github:123", sourceCommit: candidate.sourceCommit, sourceTree: candidate.sourceTree,
    topologyDigest: candidate.topologyDigest, lockDigest: candidate.lockDigest, toolchainDigest: candidate.toolchainDigest,
    artifactDigests: candidate.artifactDigests, tool: input.matchedReport.tool };
  const foundationArchive = archiveIdentity(await readFile(input.foundationArchivePath));
  const binding = { invocation, target: {
    repository: { provider: "github", repositoryId: "123", owner: "agent-teams-ai", name: "packed-sdk-fixture" },
    pullRequestNumber: 317, head: { commit: invocation.sourceCommit, tree: invocation.sourceTree },
    base: { commit: baseReference.sourceCommit, tree: baseReference.sourceTree },
    mergeBase: { commit: baseReference.sourceCommit, tree: baseReference.sourceTree },
    evaluation: { commit: invocation.sourceCommit, tree: invocation.sourceTree }, evaluationKind: "head"
  }, verifier: { identity: "packed/reviewrouter", immutableRevision: "7".repeat(40), artifactDigest: digest("packed-verifier") },
  tool: { packageName: "@agent-teams/engineering-foundation", version: invocation.tool.version,
    ...foundationArchive,
    distributionDigest: invocation.tool.artifactDigest, extractorVersion: invocation.tool.extractorVersion },
  policy: { contractRevision: "foundation:sdk-growth:c0:5", policyVersion: "foundation:sdk-growth:policy:1",
    enrollmentRevision: "8".repeat(40), configurationDigest: `sha256:${createHash("sha256").update(await readFile(join(input.repositoryRoot, "policy.yaml"))).digest("hex")}`,
    scopeDigest: digest({ domain: "reviewrouter:sdk-growth-authority:scope:1", packages: input.config.packages }),
    commandDigest: digest({ domain: "reviewrouter:sdk-growth-authority:command:1",
      entrypoint: "@agent-teams/engineering-foundation/sdk-growth-authority", operations: ["check", "promote-release"] }) },
  historyDigest: digest("packed-history"), evidenceManifestDigest: digest("packed-evidence-manifest") };
  const normalizedDecision = { ...input.decision, transitions: [...input.decision.transitions].toSorted(),
    coordinates: [...input.decision.coordinates].toSorted(compareCanonical),
    consumerEvidenceRefs: [...input.decision.consumerEvidenceRefs].toSorted(compareCanonical) };
  const decisionDigest = digest({ domain: "foundation:sdk-growth:decision:1", payload: normalizedDecision });
  const installations = new Map();
  const installedInventory = installedInventoryReader(installations);
  const archive = await packedEvidence(input.releasedArchivePath, trustedBase, input.packageName, installations);
  const candidateObservation = { ...qualifyMetadataCoverage(await selectFixtureObservation(input, input.candidateObservation, input.candidateArchivePath), rootEvidence), repository: invocation.repository };
  const candidateArchive = await packedEvidence(input.candidateArchivePath, candidateObservation, input.packageName, installations);
  const expectedCoverage = expectedReportCoverage(trustedBase, candidateObservation, input.positivePromotion === true);
  const historicalCustody = canonicalCustody([{ path: "trusted-base.json", contentHex: Buffer.from(canonicalJson(trustedBase)).toString("hex") }]);
  binding.evidenceManifestDigest = digest({ domain: "foundation:sdk-growth:evidence-manifest:2", payload: {
    archives: [{ packageName: input.packageName, custodyEvidenceDigest: archive.custodyEvidenceDigest }],
    candidates: [{ packageName: input.packageName, custodyEvidenceDigest: candidateArchive.custodyEvidenceDigest }],
    metadataRoots: [{ packageName: rootEvidence.evidence.packageName, evidenceDigest: rootEvidence.evidenceDigest }],
    retainedHistory: digest({ domain: "foundation:sdk-growth:custody:1", payload: historicalCustody })
  } });
  let admissionReceipt, admissionGrant, admissionCompletion;
  const race = {};
  const transport = {
    async resolve(request) {
      const requestDigest = digest({ domain: "reviewrouter:sdk-growth-authority:request:3", request });
      const now = controlledNow().getTime();
      const grant = { schemaVersion: "reviewrouter:sdk-growth-authority:3", kind: "grant", grantId: `packed-${request.operation}`,
        requestDigest, admissionReceipt: request.operation === "check" ? { kind: "none" } : { kind: "receipt", receipt: { ...admissionReceipt, provenance: { grant: admissionGrant, completion: admissionCompletion } } },
        binding, workflowRef: "packed/reviewrouter.yml@refs/heads/main", runRef: "packed/run/317",
        issuedAt: new Date(now - 60_000).toISOString(), expiresAt: new Date(now + 3_600_000).toISOString(),
        trustedBase, trustedBaseReference: baseReference,
        retainedHistory: { targetSource: { commit: trustedBase.sourceCommit, tree: trustedBase.sourceTree },
          targetSurfaceDigest: baseReference.surfaceDigest, receiptDigest: digest("packed-history-receipt"), custodyEvidence: historicalCustody, custodyEvidenceDigest: digest({ domain: "foundation:sdk-growth:custody:1", payload: historicalCustody }) },
        released: [{ packageName: input.packageName, releaseEvidence: { packageName: input.packageName, packageVersion: input.candidateVersion ?? "1.0.0",
          ...(input.positivePromotion ? { declaredBump: "minor" } : {}) },
          observation: archive.observation, evidence: { kind: "released", typed: input.releasedTyped, artifact: input.releasedArtifact } }],
        ownerEvidence: [{ decisionId: input.decision.decisionId, ownerRef: input.decision.ownerRef, decisionDigest,
          authenticatedSubjectId: "packed-subject", authorizationEvidenceDigest: digest("packed-authorization"),
          approvalEvidenceDigest: digest("packed-approval"), sourceBindingDigest: requestDigest }],
        archives: [archive], candidates: [candidateArchive],
        metadataRoots: [{ ...rootEvidence, ownerEvidence: { ...rootEvidence.ownerEvidence, sourceBindingDigest: requestDigest } }],
        requiredCoverageDigest: digest({ domain: "reviewrouter:sdk-growth-authority:coverage:3", coverage: expectedCoverage }),
        requiredPhases: ["topology", "observation", "packed", "decision", "trusted-base", "released", "authority"] };
      if (request.operation === "check") { admissionGrant = grant; }
      return JSON.stringify(grant);
    },
    async complete(completion) {
      if (completion.promotion.kind === "plan") { await race.mutate?.(); }
      const receipt = { schemaVersion: "reviewrouter:sdk-growth-authority:3", kind: "receipt",
        receiptId: completion.promotion.kind === "none" ? "packed-admission" : "packed-promotion", grantId: completion.grantId,
        grantDigest: completion.grantDigest, requestDigest: completion.requestDigest,
        completionDigest: digest({ domain: "reviewrouter:sdk-growth-authority:completion:3", completion }), binding: completion.binding,
        reportDigest: completion.reportDigest, coverageDigest: completion.coverageDigest, phasesDigest: completion.phasesDigest,
        verdict: completion.verdict, releaseEligible: completion.releaseEligible,
        qualification: completion.verdict === "admitted" && completion.releaseEligible ? "qualified" : "not-qualified",
        operation: completion.promotion.kind === "none" ? "check" : "promote-release", promotion: completion.promotion,
        custodyRef: "packed/receipts/317", issuedAt: controlledNow().toISOString() };
      if (completion.promotion.kind === "none") { admissionReceipt = receipt; admissionCompletion = completion; }
      return new TextEncoder().encode(JSON.stringify(receipt));
    }
  };
  await assertLegacyProtocolRejected(api, transport, input.repositoryRoot, binding);
  const verifier = api.createSdkGrowthAuthorityVerifier(transport, installedInventory, controlledNow);
  const qualified = await withinAuthorityDeadline(verifier.qualifyCheck, { consumerRoot: input.repositoryRoot, configPath: "policy.yaml", binding });
  if (input.positivePromotion) { return assertSuccessfulPackedPromotion(verifier, input, binding, qualified, race); }
  if (qualified.receipt?.qualification !== "not-qualified" || qualified.report?.verdict !== "incomplete") {
    throw new Error("Packed authority check did not preserve its completed incomplete outcome.");
  }
  let rejected = false;
  try {
    await withinAuthorityDeadline(verifier.promoteRelease, { consumerRoot: input.repositoryRoot, configPath: "policy.yaml", binding,
      admissionReceiptId: admissionReceipt.receiptId });
  } catch (error) {
    rejected = /admission-receipt|baseline|promotion/iu.test(String(error?.message))
      || error?.reason === "growth-authority-admission-receipt-invalid"
      || error?.problem?.phase === "public-api-baseline-promotion";
  }
  if (!rejected) { throw new Error("Packed authority promotion was not rejected by release preflight."); }
  return { qualification: qualified.receipt.qualification, promotionRejected: rejected };
}
