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
      readonly value: unknown;
    };

export interface ArchitectureDecisionBaselineRepository {
  read(input: {
    readonly consumerRoot: string;
    readonly path: string;
    readonly signal?: AbortSignal;
  }): Promise<ArchitectureDecisionBaselineReadResult>;
}
