import { canonicalJson, type CanonicalJsonValue } from "../canonical-json.js";
import { assertNotCancelled } from "../cancellation.js";
import type { DocumentPlanContract as DocumentPlan } from "../application/model/document-planning.js";
import type {
  DocumentAuthorityAssessment,
  DocumentAuthorityRecompiler
} from "../application/ports/document-authority-recompiler.js";
import {
  assertDocumentPlanDigests,
  documentPlanDigest
} from "../application/policies/document-contract-digests.js";
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
      assertNotCancelled(request.signal);
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
        ...(validatedPlan.schemaVersion === 2
          ? { parentPolicy: "create-missing-real-directories" as const }
          : {}),
        ...(request.signal === undefined ? {} : { signal: request.signal })
      });
      assertDocumentPlanDigests(replayed);
      assertNotCancelled(request.signal);
      const comparable = replayed.schemaVersion === 2 && validatedPlan.schemaVersion === 2
        ? (() => {
            const withoutDigest = {
              ...replayed,
              parentMaterialization: validatedPlan.parentMaterialization
            };
            return {
              ...withoutDigest,
              planDigest: documentPlanDigest({
                ...(withoutDigest as unknown as Record<string, CanonicalJsonValue>),
                planDigest: replayed.planDigest
              })
            } as DocumentPlan;
          })()
        : replayed;
      assertDocumentPlanDigests(comparable);
      return exactPlan(comparable, validatedPlan)
        ? { state: "current", plan: comparable }
        : {
            state: "stale",
            reason: "Current consumer authority reproduces a different exact Document Plan."
          };
    } catch (error) {
      assertNotCancelled(request.signal);
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
