import { canonicalJson, type CanonicalJsonValue } from "../../canonical-json.js";
import { assertNotCancelled } from "../../cancellation.js";
import type { DocumentPlan } from "../application/model/document-planning.js";
import type {
  DocumentAuthorityAssessment,
  DocumentAuthorityRecompiler
} from "../application/ports/document-authority-recompiler.js";
import { assertDocumentPlanDigests } from "../application/policies/document-contract-digests.js";
import { DocumentPlanningError } from "../document-planning-error.js";
import { NodeDocumentContractValidator } from "../adapters/node/node-document-contract-validator.js";
import { planNodeDocumentationDocument } from "./node-document-planning.js";

function exactPlan(left: DocumentPlan, right: DocumentPlan): boolean {
  return canonicalJson(left as unknown as CanonicalJsonValue) ===
    canonicalJson(right as unknown as CanonicalJsonValue);
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : "Document authority failed with an invalid error value.";
}

/** Closed Node replay of the exact planner from the Plan-embedded Intent and profile path. */
export class NodeDocumentAuthorityRecompiler
implements DocumentAuthorityRecompiler {
  async assess(request: {
    readonly consumerRoot: string;
    readonly plan: DocumentPlan;
    readonly signal?: AbortSignal;
  }): Promise<DocumentAuthorityAssessment> {
    let validatedPlan: DocumentPlan;
    try {
      assertNotCancelled(request.signal);
      validatedPlan = await new NodeDocumentContractValidator().validatePlan(request.plan);
      assertDocumentPlanDigests(validatedPlan);
    } catch (error) {
      return {
        state: "unverifiable",
        reason: `Document Plan evidence cannot be validated safely: ${reason(error)}`
      };
    }
    try {
      const replayed = await planNodeDocumentationDocument({
        consumerRoot: request.consumerRoot,
        profilePath: validatedPlan.authority.profile.path,
        intent: validatedPlan.intent,
        ...(request.signal === undefined ? {} : { signal: request.signal })
      });
      assertDocumentPlanDigests(replayed);
      assertNotCancelled(request.signal);
      return exactPlan(replayed, validatedPlan)
        ? { state: "current", plan: replayed }
        : {
            state: "stale",
            reason: "Current consumer authority reproduces a different exact Document Plan."
          };
    } catch (error) {
      if (error instanceof DocumentPlanningError &&
        error.code !== "DOCUMENT_PLANNING_AUTHORITY_UNAVAILABLE") {
        return {
          state: "stale",
          reason: `Current consumer authority no longer admits the supplied Document Plan: ${error.message}`
        };
      }
      return {
        state: "unverifiable",
        reason: `Document Plan authority cannot be reproduced safely: ${reason(error)}`
      };
    }
  }
}
