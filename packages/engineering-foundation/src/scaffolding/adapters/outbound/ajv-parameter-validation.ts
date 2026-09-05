import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";

import type { ScaffoldParameterValidation } from "../../application/ports/parameter-validation.js";
import { ScaffoldError } from "../../scaffold-error.js";

function validationMessage(validate: ValidateFunction): string {
  return (validate.errors ?? [])
    .slice(0, 8)
    .map((error) => `${error.instancePath || "/"} ${error.message ?? "is invalid"}`)
    .join("; ")
    .slice(0, 1000);
}

export class AjvScaffoldParameterValidation implements ScaffoldParameterValidation {
  readonly #validators = new WeakMap<object, ValidateFunction>();

  validate(input: Parameters<ScaffoldParameterValidation["validate"]>[0]): void {
    let validate = this.#validators.get(input.schema);
    if (validate === undefined) {
      const ajv = new Ajv2020({ allErrors: true, strict: true });
      validate = ajv.compile(input.schema);
      this.#validators.set(input.schema, validate);
    }
    if (!validate(input.parameters)) {
      throw new ScaffoldError(
        "SCAFFOLD_INPUT_INVALID",
        `Invalid parameters for ${input.definitionKey}: ${validationMessage(validate)}`
      );
    }
  }
}
