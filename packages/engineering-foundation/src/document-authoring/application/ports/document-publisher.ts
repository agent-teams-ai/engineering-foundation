import type { DocumentOwnedTemporary } from "../model/document-transaction.js";
import type { DocumentPlan } from "../model/document-planning.js";

export interface DocumentPublisher {
  prepare(request: {
    readonly consumerRoot: string;
    readonly plan: DocumentPlan;
  }): Promise<DocumentOwnedTemporary>;
  publishPrepared(request: {
    readonly consumerRoot: string;
    readonly plan: DocumentPlan;
    readonly temporary: DocumentOwnedTemporary;
  }): Promise<"already-satisfied" | "published">;
  removeOwnedTemporary(request: {
    readonly consumerRoot: string;
    readonly temporary: DocumentOwnedTemporary;
  }): Promise<void>;
}
