import type {
  JsonObject
} from "../model/scaffold-values.js";

/** Validates data for one immutable, Foundation-owned definition. */
export interface ScaffoldParameterValidation {
  validate(input: {
    readonly definitionKey: string;
    readonly schema: object;
    readonly parameters: JsonObject;
  }): void;
}
