import { createManagedProcessExecutor } from "../../process-execution/module.js";
import { pathTraversesSymbolicLink, readContainedRegularFile } from "../../source-inventory/node.js";
import { createWorkspaceInventoryReader } from "../../workspace-inventory/module.js";
import { assertGrowthReportDestination } from "./adapters/inbound/configuration/parse-growth-config.js";
import { loadCapabilityConfig, type PublicApiConfigurationDependencies } from "./adapters/inbound/configuration/load-capability-config.js";
import { createFilesystemGrowthInputContext } from "./adapters/outbound/filesystem/growth-input-context.js";
import { readGrowthInvocation, assertGrowthDestination, growthBytesDigest, readGrowthInputFile } from "./adapters/outbound/filesystem/growth-invocation.js";
import { createFilesystemGrowthReportWriter, parseFinalizedGrowthReport } from "./adapters/outbound/filesystem/growth-report-writer.js";
import { createWorkspaceGrowthReader } from "./adapters/outbound/filesystem/workspace-growth-reader.js";
import { ReviewRouterGrowthAuthorityAcl } from "./adapters/outbound/reviewrouter/reviewrouter-growth-authority-acl.js";
import { VerifiedGrowthInputContext } from "./adapters/outbound/reviewrouter/verified-growth-input-context.js";
import type { SdkGrowthAuthorityTransport } from "./adapters/inbound/authority/growth-authority-contract.js";
import type { GrowthAuthorityBinding, GrowthAuthorityReceipt, GrowthPromotionPlan } from "./application/model/growth-authority.js";
import { growthAuthoritySchemaVersion } from "./application/model/growth-authority.js";
import { GrowthObservationInvariantError } from "./application/model/growth-observation.js";
import type { JsonSchemaSetInspector } from "./application/ports/package-artifact-inventory.js";
import { hashGrowthPayload } from "./application/policies/compare-growth-surfaces.js";
import { growthCanonicalJson } from "./application/policies/normalize-growth-observation.js";
import { growthAuthorityGrantDigest, growthAuthorityRepositoryIdentity, growthPromotionPlanDigest, growthReportAuthorityDigests, validateGrowthAuthorityBinding } from "./application/policies/validate-growth-authority.js";
import { preflightPublicApiPromotions } from "./application/use-cases/preflight-public-api-promotions.js";
import { qualifySdkGrowth } from "./application/use-cases/qualify-sdk-growth.js";
import { loadStrictYamlFile } from "../../features/configuration-input/node.js";
import { createPublicApiArtifactDependencies, createPublicApiCompatibilityDependencies } from "./module.js";

const files = { read: readContainedRegularFile };
const paths = { traversesSymbolicLink: pathTraversesSymbolicLink };
const commandDigestPayload = Object.freeze({ domain: "reviewrouter:sdk-growth-authority:command:1",
  entrypoint: "@agent-teams/engineering-foundation/sdk-growth-authority", operations: ["check", "promote-release"] });

export interface SdkGrowthAuthorityOperationInput {
  readonly consumerRoot: string;
  readonly configPath: string;
  readonly binding: GrowthAuthorityBinding;
  readonly signal?: AbortSignal;
}

export interface SdkGrowthAuthorityModuleDependencies {
  readonly transport: SdkGrowthAuthorityTransport;
  readonly readAcceptedDecisions: import("./application/ports/accepted-decision-evidence.js").AcceptedArchitectureDecisionReader;
  readonly assertSchema: PublicApiConfigurationDependencies["assertSchema"];
  readonly inspector: JsonSchemaSetInspector;
  readonly now?: () => Date;
}

function invariant(condition: boolean, reason: string): asserts condition {
  if (!condition) { throw new GrowthObservationInvariantError(reason); }
}

/** Trusted ReviewRouter port/adapter assembly. This module publishes no status
 * and owns no ReviewRouter persistence or authentication implementation. */
export function createSdkGrowthAuthorityModule(dependencies: SdkGrowthAuthorityModuleDependencies) {
  const common = createPublicApiCompatibilityDependencies(dependencies.readAcceptedDecisions, dependencies.assertSchema);
  const processes = createManagedProcessExecutor();

  async function setup(input: SdkGrowthAuthorityOperationInput, operation: "check" | "promote-release", admissionReceiptId?: string) {
    const policy = await loadCapabilityConfig({ readYaml: loadStrictYamlFile, assertSchema: dependencies.assertSchema }, input.consumerRoot, input.configPath, input.signal);
    invariant(policy.schemaVersion === 2, "growth-authority-v2-required");
    await assertGrowthDestination(input.consumerRoot, policy.sdkGrowth.reportPath);
    const inventory = await createWorkspaceGrowthReader(createWorkspaceInventoryReader()).read(input.consumerRoot, "pnpm-workspace.yaml", input.signal);
    assertGrowthReportDestination(policy.sdkGrowth.reportPath, inventory.packages.flatMap((pkg) => [pkg.rootPath, pkg.manifestPath]));
    const identityInputs = { files, runGit: (args: readonly string[], signal?: AbortSignal) => processes.run({
      command: "git", args, cwd: input.consumerRoot, timeoutMs: 10_000, ...(signal === undefined ? {} : { signal })
    }) };
    const binding = validateGrowthAuthorityBinding(input.binding);
    const mapInvocation = async (signal?: AbortSignal) => {
      const observed = await readGrowthInvocation(input.consumerRoot, inventory, identityInputs, signal);
      return { ...observed, repository: growthAuthorityRepositoryIdentity(binding.target.repository) };
    };
    const invocation = await mapInvocation(input.signal);
    invariant(growthCanonicalJson(binding.invocation) === growthCanonicalJson(invocation), "growth-authority-invocation-mismatch");
    const configBytes = await readGrowthInputFile(input.consumerRoot, input.configPath, files);
    invariant(binding.policy.configurationDigest === growthBytesDigest(configBytes), "growth-authority-policy-digest-mismatch");
    const scopeDigest = hashGrowthPayload({ domain: "reviewrouter:sdk-growth-authority:scope:1", packages: policy.compatibility.packages }, common.fingerprint);
    invariant(binding.policy.scopeDigest === scopeDigest, "growth-authority-scope-digest-mismatch");
    const commandDigest = hashGrowthPayload(commandDigestPayload, common.fingerprint);
    invariant(binding.policy.commandDigest === commandDigest, "growth-authority-command-digest-mismatch");
    const authority = new ReviewRouterGrowthAuthorityAcl(dependencies.transport, common.fingerprint, dependencies.now);
    const candidate = createFilesystemGrowthInputContext({ consumerRoot: input.consumerRoot, policy: policy.compatibility }, { ...common, assertSchema: dependencies.assertSchema });
    const context = new VerifiedGrowthInputContext({ candidate, authority, binding, operation,
      ...(admissionReceiptId === undefined ? {} : { admissionReceiptId }), fingerprint: common.fingerprint, assertSchema: dependencies.assertSchema });
    const readInvocation = (cancellation: import("./application/model/growth-observation.js").GrowthCancellation) =>
      mapInvocation(cancellation.signal);
    return { policy, inventory, invocation, binding, authority, context, readInvocation };
  }

  return Object.freeze({
    async qualifyCheck(input: SdkGrowthAuthorityOperationInput) {
      const state = await setup(input, "check");
      return qualifySdkGrowth({ consumerRoot: input.consumerRoot, policy: state.policy, invocation: state.invocation,
        ...(input.signal === undefined ? {} : { signal: input.signal }) }, {
        repository: common.repository, fingerprint: common.fingerprint, typed: common.extractor,
        artifact: new (await import("./adapters/outbound/filesystem/filesystem-package-artifact-inventory.js")).FilesystemPackageArtifactInventory(dependencies.inspector, { files, paths }),
        workspace: { read: async () => state.inventory }, context: state.context, authority: state.authority,
        writer: createFilesystemGrowthReportWriter(input.consumerRoot), readInvocation: state.readInvocation
      });
    },

    async promoteRelease(input: SdkGrowthAuthorityOperationInput & { readonly admissionReceiptId: string }): Promise<{ readonly snapshots: readonly import("./application/model/public-api.js").PublicApiSnapshot[]; readonly receipt: GrowthAuthorityReceipt }> {
      const state = await setup(input, "promote-release", input.admissionReceiptId);
      const cancellation = { ...(input.signal === undefined ? {} : { signal: input.signal }), throwIfCancelled() {
        if (input.signal?.aborted === true) { throw input.signal.reason; }
      } };
      await state.context.read({ ...state.policy.sdkGrowth.comparison, decisionsPath: state.policy.sdkGrowth.decisionsPath }, cancellation);
      const resolved = state.context.resolution();
      invariant(resolved.grant.admissionReceipt.kind === "receipt", "growth-authority-admission-receipt-required");
      const reportBytes = await readGrowthInputFile(input.consumerRoot, state.policy.sdkGrowth.reportPath, files);
      const report = parseFinalizedGrowthReport(reportBytes, common.fingerprint);
      const reportDigest = growthBytesDigest(reportBytes);
      invariant(resolved.grant.admissionReceipt.receipt.reportDigest === reportDigest, "growth-authority-admission-report-mismatch");
      invariant(report.verdict === "admitted" && report.releaseEligible, "growth-authority-admission-report-ineligible");
      const reportDigests = growthReportAuthorityDigests(report, common.fingerprint);
      invariant(resolved.grant.admissionReceipt.receipt.coverageDigest === reportDigests.coverageDigest
        && resolved.grant.admissionReceipt.receipt.phasesDigest === reportDigests.phasesDigest,
      "growth-authority-admission-report-mismatch");
      invariant(reportDigests.coverageDigest === resolved.grant.requiredCoverageDigest, "growth-authority-coverage-mismatch");
      const artifacts = await createPublicApiArtifactDependencies(input.consumerRoot, state.policy.compatibility.packages, common, dependencies.inspector, input.signal);
      let receipt: GrowthAuthorityReceipt | undefined;
      const snapshots = await preflightPublicApiPromotions({ consumerRoot: input.consumerRoot, policy: state.policy.compatibility,
        ...(input.signal === undefined ? {} : { signal: input.signal }) }, [common, artifacts], async (writes) => {
          invariant(writes.length === new Set(writes.map((entry) => entry.destination)).size, "growth-authority-promotion-destination-duplicate");
          const plan: GrowthPromotionPlan = { binding: state.binding, writes: writes.toSorted((a, b) => a.destination < b.destination ? -1 : a.destination > b.destination ? 1 : 0) };
          const planDigest = growthPromotionPlanDigest(plan, common.fingerprint);
          const completion = { schemaVersion: growthAuthoritySchemaVersion, kind: "completion" as const, grantId: resolved.grant.grantId,
            grantDigest: growthAuthorityGrantDigest(resolved.grant, common.fingerprint), requestDigest: resolved.requestDigest, binding: state.binding,
            reportDigest, reportByteLength: reportBytes.byteLength, coverageDigest: reportDigests.coverageDigest, phasesDigest: reportDigests.phasesDigest,
            verdict: report.verdict, releaseEligible: report.releaseEligible, publication: "finalized" as const,
            promotion: { kind: "plan" as const, planDigest } };
          receipt = await state.authority.complete(completion, cancellation);
          invariant(receipt.qualification === "qualified" && receipt.operation === "promote-release"
            && receipt.promotion.kind === "plan" && receipt.promotion.planDigest === planDigest, "growth-authority-promotion-receipt-invalid");
          invariant(growthCanonicalJson(await state.readInvocation(cancellation)) === growthCanonicalJson(state.invocation), "growth-execution-inputs-changed");
        });
      invariant(receipt !== undefined, "growth-authority-promotion-not-authorized");
      return { snapshots, receipt };
    }
  });
}
