import type { DocumentOwnedTemporary } from "../model/document-transaction.js";
import type { DocumentPlan } from "../model/document-planning.js";

export type DocumentDestinationState =
  | { readonly state: "absent" }
  | { readonly state: "exact" }
  | { readonly state: "conflict"; readonly reason: string };

export type DocumentTemporaryState =
  | { readonly state: "absent" }
  | { readonly state: "owned-exact"; readonly temporary: DocumentOwnedTemporary }
  | { readonly state: "conflict"; readonly reason: string };

export interface DocumentFileState {
  classifyDestination(request: {
    readonly consumerRoot: string;
    readonly plan: DocumentPlan;
  }): Promise<DocumentDestinationState>;
  classifyTemporary(request: {
    readonly consumerRoot: string;
    readonly temporary: DocumentOwnedTemporary;
  }): Promise<DocumentTemporaryState>;
}
