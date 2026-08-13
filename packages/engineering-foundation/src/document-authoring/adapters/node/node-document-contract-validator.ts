import { CapabilityInputError } from "../../../capability-runtime.js";
import { assertSchema } from "../../../schema-catalog.js";
import type {
  DocumentIntent,
  DocumentPlan
} from "../../application/model/document-planning.js";
import type { DocumentContractValidator } from "../../application/ports/document-contract-validator.js";
import { DocumentPlanningError } from "../../document-planning-error.js";

function invalidContract(kind: "Intent" | "Plan", error: CapabilityInputError): never {
  throw new DocumentPlanningError(
    "DOCUMENT_PLANNING_INPUT_INVALID",
    `Document ${kind} does not match its v1 contract: ${error.message.slice(0, 1000)}`,
    { cause: error }
  );
}

export class NodeDocumentContractValidator implements DocumentContractValidator {
  async validateIntent(input: unknown): Promise<DocumentIntent> {
    try {
      await assertSchema("document-intent/v1", input, "document-intent");
      return input as DocumentIntent;
    } catch (error) {
      if (error instanceof CapabilityInputError) {
        invalidContract("Intent", error);
      }
      throw error;
    }
  }

  async validatePlan(input: unknown): Promise<DocumentPlan> {
    try {
      await assertSchema("document-plan/v1", input, "document-plan");
      return input as DocumentPlan;
    } catch (error) {
      if (error instanceof CapabilityInputError) {
        invalidContract("Plan", error);
      }
      throw error;
    }
  }
}
