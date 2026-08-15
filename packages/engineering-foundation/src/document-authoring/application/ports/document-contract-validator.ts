import type {
  DocumentIntent,
  DocumentPlanContract as DocumentPlan
} from "../model/document-planning.js";

export interface DocumentContractValidator {
  validateIntent(input: unknown): Promise<DocumentIntent>;
  validatePlan(input: unknown): Promise<DocumentPlan>;
}
