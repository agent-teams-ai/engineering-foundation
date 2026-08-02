import type { AcceptedArchitectureDecisionBaseline } from "../model/architecture-decision.js";

export type ArchitectureDecisionBaselineReadResult =
  | {
      readonly kind: "invalid";
      readonly message: string;
    }
  | {
      readonly kind: "missing";
    }
  | {
      readonly kind: "unsafe";
      readonly message: string;
    }
  | {
      readonly kind: "valid";
      /** Opaque adapter-issued revision used to reject concurrent baseline changes. */
      readonly revision: string;
      readonly value: unknown;
    };

export type ArchitectureDecisionBaselineExpectedState =
  | {
      readonly kind: "missing";
    }
  | {
      readonly kind: "valid";
      readonly revision: string;
    };

export type ArchitectureDecisionBaselineWriteResult =
  | "created"
  | "unchanged"
  | "updated";

export interface ArchitectureDecisionBaselineRepository {
  read(input: {
    readonly consumerRoot: string;
    readonly path: string;
    readonly signal?: AbortSignal;
  }): Promise<ArchitectureDecisionBaselineReadResult>;

  write(input: {
    readonly baseline: AcceptedArchitectureDecisionBaseline;
    readonly consumerRoot: string;
    readonly expected: ArchitectureDecisionBaselineExpectedState;
    readonly path: string;
    readonly signal?: AbortSignal;
  }): Promise<ArchitectureDecisionBaselineWriteResult>;
}
