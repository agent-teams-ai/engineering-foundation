import type {
  ExecutableSpecification,
  ExecutableSpecificationObservation
} from "../model/executable-specification.js";

export interface ExecutableSpecificationInspector {
  inspect(input: {
    readonly consumerRoot: string;
    readonly specification: ExecutableSpecification;
    readonly signal?: AbortSignal;
  }): Promise<ExecutableSpecificationObservation>;
}
