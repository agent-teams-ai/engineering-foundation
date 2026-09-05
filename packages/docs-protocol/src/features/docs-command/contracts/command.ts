// Wire vocabulary belongs to this outer contract. Application operation models
// remain independent; public type and schema tests check the projection for drift.
export interface DocsCommandEnvelopeV2<Result = unknown> {
  readonly schemaVersion: 2;
  readonly protocol: {
    readonly id: "agent-teams.docs-protocol";
    readonly version: 1;
  };
  readonly command:
    | "docs.check"
    | "docs.doctor"
    | "docs.find"
    | "docs.info"
    | "docs.new"
    | "docs.recover";
  readonly outcome:
    | "authority-stale"
    | "cancelled"
    | "conflict"
    | "execution-failure"
    | "invalid-input"
    | "recovery-required"
    | "success"
    | "violation";
  readonly diagnostics: readonly {
    readonly message: string;
    readonly phase: "apply" | "authority" | "input" | "planning" | "query" | "recovery";
    readonly ruleId: string;
    readonly severity: "error" | "info" | "warning";
    readonly subject: string;
  }[];
  readonly result: Result;
}

export interface DocsExecutionV2<Result> {
  readonly envelope: DocsCommandEnvelopeV2<Result>;
  readonly exitCode: 0 | 1 | 2 | 3 | 130;
}

export interface DocsCommandEnvelopeV3<Result = unknown> {
  readonly schemaVersion: 3;
  readonly protocol: DocsCommandEnvelopeV2["protocol"];
  readonly command: DocsCommandEnvelopeV2["command"] | "docs.context" | "docs.init";
  readonly outcome: DocsCommandEnvelopeV2["outcome"];
  readonly diagnostics: DocsCommandEnvelopeV2["diagnostics"];
  readonly result: Result;
}

export interface DocsExecutionV3<Result> {
  readonly envelope: DocsCommandEnvelopeV3<Result>;
  readonly exitCode: 0 | 1 | 2 | 3 | 130;
}
