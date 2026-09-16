import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

function canonicalJson(value) {
  if (value === null || typeof value !== "object") { return JSON.stringify(value); }
  if (Array.isArray(value)) { return `[${value.map(canonicalJson).join(",")}]`; }
  return `{${Object.entries(value).toSorted(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
}

const digest = value => `sha256:${createHash("sha256").update(canonicalJson(value), "utf8").digest("hex")}`;
const sha512Integrity = value => `sha512-${createHash("sha512").update(canonicalJson(value), "utf8").digest("base64")}`;
const compareCanonical = (left, right) => canonicalJson(left) < canonicalJson(right) ? -1 : canonicalJson(left) > canonicalJson(right) ? 1 : 0;

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
  const trustedBase = { ...input.trustedBase, repository: "github:123" };
  const baseReference = { ...input.baseReference,
    surfaceDigest: digest({ domain: "foundation:sdk-growth:observation:1", payload: trustedBase }) };
  const invocation = { repository: "github:123", sourceCommit: candidate.sourceCommit, sourceTree: candidate.sourceTree,
    topologyDigest: candidate.topologyDigest, lockDigest: candidate.lockDigest, toolchainDigest: candidate.toolchainDigest,
    artifactDigests: candidate.artifactDigests, tool: input.matchedReport.tool };
  const binding = { invocation, target: {
    repository: { provider: "github", repositoryId: "123", owner: "agent-teams-ai", name: "packed-sdk-fixture" },
    pullRequestNumber: 317, head: { commit: invocation.sourceCommit, tree: invocation.sourceTree },
    base: { commit: baseReference.sourceCommit, tree: baseReference.sourceTree },
    mergeBase: { commit: baseReference.sourceCommit, tree: baseReference.sourceTree },
    evaluation: { commit: invocation.sourceCommit, tree: invocation.sourceTree }, evaluationKind: "head"
  }, verifier: { identity: "packed/reviewrouter", immutableRevision: "7".repeat(40), artifactDigest: digest("packed-verifier") },
  tool: { packageName: "@agent-teams/engineering-foundation", version: invocation.tool.version,
    archiveDigest: digest("packed-foundation-archive"), archiveIntegrity: sha512Integrity("packed-foundation-archive"),
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
  const artifactPayload = { domain: "reviewrouter:sdk-growth-authority:artifact-snapshot:1", snapshot: input.releasedArtifact };
  const archive = { archiveDigest: digest(artifactPayload), archiveIntegrity: sha512Integrity(artifactPayload) };
  const expectedCoverage = input.matchedReport.coverage;
  let admissionReceipt;
  const transport = {
    async resolve(request) {
      const requestDigest = digest({ domain: "reviewrouter:sdk-growth-authority:request:1", request });
      const now = Date.now();
      const grant = { schemaVersion: "reviewrouter:sdk-growth-authority:1", kind: "grant", grantId: `packed-${request.operation}`,
        requestDigest, admissionReceipt: request.operation === "check" ? { kind: "none" } : { kind: "receipt", receipt: admissionReceipt },
        binding, workflowRef: "packed/reviewrouter.yml@refs/heads/main", runRef: "packed/run/317",
        issuedAt: new Date(now - 60_000).toISOString(), expiresAt: new Date(now + 3_600_000).toISOString(),
        trustedBase, trustedBaseReference: baseReference,
        retainedHistory: { targetSource: { commit: trustedBase.sourceCommit, tree: trustedBase.sourceTree },
          targetSurfaceDigest: baseReference.surfaceDigest, receiptDigest: digest("packed-history-receipt"), custodyEvidenceDigest: digest("packed-history-custody") },
        released: [{ packageName: input.packageName, releaseEvidence: { packageName: input.packageName, packageVersion: "1.0.0" },
          observation: trustedBase, evidence: { kind: "released", typed: input.releasedTyped, artifact: input.releasedArtifact } }],
        ownerEvidence: [{ decisionId: input.decision.decisionId, ownerRef: input.decision.ownerRef, decisionDigest,
          authenticatedSubjectId: "packed-subject", authorizationEvidenceDigest: digest("packed-authorization"),
          approvalEvidenceDigest: digest("packed-approval"), sourceBindingDigest: requestDigest }],
        archives: [{ packageName: input.packageName, packageVersion: "1.0.0", source: binding.target.evaluation,
          ...archive, custodyEvidenceDigest: digest("packed-archive-custody") }],
        requiredCoverageDigest: digest({ domain: "reviewrouter:sdk-growth-authority:coverage:1", coverage: expectedCoverage }),
        requiredPhases: ["topology", "observation", "packed", "decision", "trusted-base", "released", "authority"] };
      return JSON.stringify(grant);
    },
    async complete(completion) {
      const receipt = { schemaVersion: "reviewrouter:sdk-growth-authority:1", kind: "receipt",
        receiptId: completion.promotion.kind === "none" ? "packed-admission" : "packed-promotion", grantId: completion.grantId,
        grantDigest: completion.grantDigest,
        completionDigest: digest({ domain: "reviewrouter:sdk-growth-authority:completion:1", completion }), binding: completion.binding,
        reportDigest: completion.reportDigest, coverageDigest: completion.coverageDigest, phasesDigest: completion.phasesDigest,
        verdict: completion.verdict, releaseEligible: completion.releaseEligible,
        qualification: completion.verdict === "admitted" && completion.releaseEligible ? "qualified" : "not-qualified",
        operation: completion.promotion.kind === "none" ? "check" : "promote-release", promotion: completion.promotion,
        custodyRef: "packed/receipts/317", issuedAt: new Date().toISOString() };
      if (completion.promotion.kind === "none") { admissionReceipt = receipt; }
      return new TextEncoder().encode(JSON.stringify(receipt));
    }
  };
  const verifier = api.createSdkGrowthAuthorityVerifier(transport);
  const qualified = await verifier.qualifyCheck({ consumerRoot: input.repositoryRoot, configPath: "policy.yaml", binding });
  if (qualified.receipt?.qualification !== "not-qualified" || qualified.report?.verdict !== "incomplete") {
    throw new Error("Packed authority check did not preserve its completed incomplete outcome.");
  }
  let rejected = false;
  try {
    await verifier.promoteRelease({ consumerRoot: input.repositoryRoot, configPath: "policy.yaml", binding,
      admissionReceiptId: admissionReceipt.receiptId });
  } catch (error) {
    rejected = /admission-receipt|baseline|promotion/iu.test(String(error?.message))
      || error?.reason === "growth-authority-admission-receipt-invalid"
      || error?.problem?.phase === "public-api-baseline-promotion";
  }
  if (!rejected) { throw new Error("Packed authority promotion was not rejected by release preflight."); }
}
