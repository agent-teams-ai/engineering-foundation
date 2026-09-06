import type { FoundationCheck, FoundationConfigReader } from "../../foundation-check/api.js";
import type { CapabilityInvocation, FoundationCheckReport, RuleExplanation } from "../../validation-reporting/api.js";
import type { AttachResult, FoundationDevOnlyStatus, FoundationStatus, FoundationTransactionAwareStatus } from "../../../local-mode/api.js";
import type { CommandInvocation } from "./command-invocation.js";

export type CommandSignal = "SIGINT" | "SIGTERM";
export interface CommandCancellation {
  withSignal<T>(signals: readonly CommandSignal[], operation: (signal: AbortSignal) => Promise<T>): Promise<T>;
}

/** Only the operations consumed by the CLI; concrete services are selected in composition. */
export interface FoundationCommandServices<SchemaId extends string = string> {
  readonly cancellation: CommandCancellation;
  readonly check: FoundationCheck;
  readonly renderCheck: (report: FoundationCheckReport) => string;
  readonly readConfig: FoundationConfigReader;
  readonly localMode: {
    attach(consumerRoot: string, target: string): Promise<AttachResult>;
    assertDevOnly(consumerRoot: string): Promise<FoundationDevOnlyStatus>;
    assertRegistry(consumerRoot: string): Promise<FoundationStatus>;
    detach(consumerRoot: string): Promise<FoundationStatus>;
    status(consumerRoot: string): Promise<FoundationStatus>;
  };
  readonly qualityGate: (input: CommandInvocation) => Promise<boolean>;
  readonly agentWorkflow: {
    changed(input: CapabilityInvocation & { readonly format: "json" | "text"; readonly baseRef?: string }): Promise<void>;
    instructions(input: { readonly consumerRoot: string; readonly targetPath: string; readonly format: "json" | "text"; readonly signal?: AbortSignal }): Promise<void>;
  };
  readonly rules: ReadonlyMap<string, RuleExplanation>;
  readonly promoteDecisions: (input: CapabilityInvocation) => Promise<{ readonly writeResult: string }>;
  readonly promotePublicApi: (input: CapabilityInvocation) => Promise<readonly unknown[]>;
  readonly loadProtobufQualifier: () => Promise<(input: CapabilityInvocation & { readonly executablePath: string; readonly write: boolean }) => Promise<{
    readonly writeResult: string;
    readonly status: string;
    readonly evidencePath: string;
  }>>;
  readonly scaffold: (input: CommandInvocation, json: boolean) => Promise<boolean>;
  readonly inspectPackage: () => Promise<unknown>;
  readonly installedVersion: () => Promise<string>;
  readonly isSchemaId: (value: string) => value is SchemaId;
  readonly readSchema: (id: SchemaId) => Promise<string>;
}

export type CommandModeStatus = FoundationStatus | FoundationTransactionAwareStatus;
export type CommandDevOnlyStatus = FoundationDevOnlyStatus;
