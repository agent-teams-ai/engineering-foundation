import { normalizeCodeAnchors, normalizeDocumentIds } from "../../portable-documentation/domain.js";
import type { DocsNewRequest } from "../../portable-documentation/application.js";
import { documentResult, requireSuccess, signalOption, type PortableQualificationProtocol } from "./runtime.js";

export interface QualificationRecoveryDependencies {
  readonly readProfile: (input: { readonly consumerRoot: string; readonly profilePath: string; readonly signal?: AbortSignal }) => Promise<{ readonly foundationProfile: { readonly path: string } }>;
  readonly planDocument: (input: {
    readonly consumerRoot: string;
    readonly profilePath: string;
    readonly parentPolicy: "create-missing-real-directories";
    readonly intent: DocsNewRequest["intent"] & { readonly schemaVersion: 1; readonly related?: readonly string[]; readonly additionalMetadata?: DocsNewRequest["additionalMetadata"] };
    readonly signal?: AbortSignal;
  }) => Promise<{ readonly destination: string; readonly planDigest: string }>;
  readonly crashAtDurablePublishing: (consumerRoot: string, plan: unknown, signal?: AbortSignal) => Promise<void>;
}

function qualificationMetadata(
  base: Omit<DocsNewRequest, "apply">,
  blockedBy: readonly string[],
  codeAnchors: readonly { readonly enforcement: "advisory" | "required"; readonly pattern: string }[]
) {
  return {
    ...base.additionalMetadata,
    ...(blockedBy.length === 0 ? {} : { blocked_by: blockedBy }),
    ...(codeAnchors.length === 0
      ? {}
      : { code_anchors: codeAnchors.map(({ enforcement, pattern }) => ({ enforcement, pattern })) })
  };
}

export function createInterruptAndRecover(dependencies: QualificationRecoveryDependencies) {
  return async function interruptAndRecover(input: {
    readonly base: Omit<DocsNewRequest, "apply">;
    readonly consumerRoot: string;
    readonly previewResult: ReturnType<typeof documentResult>;
    readonly profilePath: string;
    readonly protocol: PortableQualificationProtocol;
  }): Promise<{
    readonly receiptDigest: string;
    readonly receipt: {
      readonly commit: { readonly publication: "published"; readonly state: "committed" };
      readonly directoryMaterialization?: {
        readonly observedCreatedDirectories: readonly string[];
        readonly state: string;
      };
      readonly outcome: "applied";
    };
  }> {
    const profile = await dependencies.readProfile({
      consumerRoot: input.consumerRoot,
      profilePath: input.profilePath,
      ...signalOption(input.base.signal)
    });
    const blockedBy = normalizeDocumentIds(input.base.blockedBy ?? [], "blocked_by");
    const related = normalizeDocumentIds([...(input.base.related ?? []), ...blockedBy], "related");
    const codeAnchors = normalizeCodeAnchors(input.base.codeAnchors ?? []);
    const additionalMetadata = qualificationMetadata(input.base, blockedBy, codeAnchors);
    const crashPlan = await dependencies.planDocument({
      consumerRoot: input.consumerRoot,
      profilePath: profile.foundationProfile.path,
      parentPolicy: "create-missing-real-directories",
      intent: {
        schemaVersion: 1,
        ...input.base.intent,
        ...(related.length === 0 ? {} : { related }),
        ...(Object.keys(additionalMetadata).length === 0 ? {} : { additionalMetadata })
      },
      ...signalOption(input.base.signal)
    });
    if (crashPlan.destination !== input.previewResult.documentPath || crashPlan.planDigest !== input.previewResult.planDigest) {
      throw new Error("Qualification crash Plan differs from the unified Docs Protocol preview.");
    }
    await dependencies.crashAtDurablePublishing(input.consumerRoot, crashPlan, input.base.signal);
    const interruptedDoctor = await input.protocol.doctorV2({
      consumerRoot: input.consumerRoot,
      profilePath: input.profilePath,
      ...signalOption(input.base.signal)
    });
    if (interruptedDoctor.exitCode !== 1 || interruptedDoctor.envelope.outcome !== "recovery-required" ||
      interruptedDoctor.envelope.result.transaction.state !== "recoverable") {
      throw new Error("Qualification doctor did not observe its genuine interrupted transaction.");
    }
    const recovered = await input.protocol.recoverV2({
      consumerRoot: input.consumerRoot,
      profilePath: input.profilePath,
      ...signalOption(input.base.signal)
    });
    requireSuccess("recover", recovered);
    if (recovered.envelope.result.transactionState !== "recovered" || recovered.envelope.result.writeState !== "committed" ||
      typeof recovered.envelope.result.receiptDigest !== "string" || recovered.envelope.result.receipt.outcome !== "applied" ||
      recovered.envelope.result.receipt.commit.state !== "committed" || recovered.envelope.result.receipt.commit.publication !== "published") {
      throw new Error("Qualification recovery did not return truthful committed Receipt evidence.");
    }
    return recovered.envelope.result as {
      readonly receiptDigest: string;
      readonly receipt: {
        readonly commit: { readonly publication: "published"; readonly state: "committed" };
        readonly directoryMaterialization?: { readonly observedCreatedDirectories: readonly string[]; readonly state: string };
        readonly outcome: "applied";
      };
    };
  };
}
