import type {
  ExecutableSpecificationCatalog,
  ExecutableSpecificationObservation
} from "../model/executable-specification.js";

export interface ExecutableSpecificationInspector {
  inspectCatalog(input: {
    readonly consumerRoot: string;
    readonly catalog: ExecutableSpecificationCatalog;
    readonly signal?: AbortSignal;
  }): Promise<readonly ExecutableSpecificationObservation[]>;
}
