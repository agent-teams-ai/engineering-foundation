import type { AuditPackageInput } from "../../../contract/public-api-audit.js";
import type { PublicApiObserver } from "../../../application/ports/public-api-observer.js";
import { type AuditReference } from "../../../application/model/public-api-observation.js";

type ObserverInput = Parameters<PublicApiObserver["observe"]>[0];
export interface ObservationContext {
  readonly input: ObserverInput;
  readonly allowed: ReadonlyMap<string, string>;
  readonly subjectRoot: string;
  readonly pkg: AuditPackageInput;
  readonly dependencyBindings: Map<AuditReference, string>;
  readonly entry: AuditPackageInput["entrypoints"][number] | undefined;
}
