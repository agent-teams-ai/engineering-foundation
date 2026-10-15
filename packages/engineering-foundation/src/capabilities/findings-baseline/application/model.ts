import type { Finding } from "./baseline.js";

/** Rule namespace owned by the Oxlint producer; the baseline entries of other namespaces are never read here. */
export const OXLINT_NAMESPACE = "oxlint" as const;

export interface FindingsBaselinePolicy {
  readonly baselinePath: string;
  readonly oxlint: {
    readonly configPath: string;
    readonly roots: readonly string[];
    /** Rules whose message carries a measured value, as `<plugin>/<rule>`. */
    readonly measuredRules: readonly string[];
  };
}

/** Observes the current findings of one rule namespace. */
export interface FindingsProducer {
  observe(input: { readonly consumerRoot: string; readonly policy: FindingsBaselinePolicy; readonly signal?: AbortSignal }): Promise<readonly Finding[]>;
}

export interface FindingsBaselineStore {
  /** The baseline text, or `undefined` when the file does not exist. */
  read(consumerRoot: string, path: string, signal?: AbortSignal): Promise<string | undefined>;
  /** Creates the file and fails when it exists. */
  create(consumerRoot: string, path: string, text: string): Promise<void>;
  /** Replaces the file only while it still holds `expected`. */
  replace(consumerRoot: string, path: string, text: string, expected: string): Promise<void>;
}

export interface FindingsBaselineDependencies {
  readonly producer: FindingsProducer;
  readonly store: FindingsBaselineStore;
}
