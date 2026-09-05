import type { DocsFindQuery, DocsNewRequest } from "../../portable-documentation/application.js";

export interface DocsProtocolQualificationScenario {
  readonly find: {
    readonly expectedIds: readonly string[];
    readonly query: DocsFindQuery;
  };
  readonly newDocument: Omit<DocsNewRequest, "apply" | "consumerRoot" | "profilePath" | "signal">;
}

export interface DocsProtocolQualificationRequest {
  readonly fixtureRoot: string;
  readonly profilePath?: string;
  readonly scenario: DocsProtocolQualificationScenario;
  readonly signal?: AbortSignal;
}

export interface DocsProtocolQualificationReceipt {
  readonly appliedDocumentPath: string;
  readonly checks: readonly ["info", "find", "preview", "crash", "doctor", "recover", "receipt", "parent", "apply", "index", "check", "source-unchanged"];
  readonly projectId: string;
  readonly schemaVersion: 1;
}
