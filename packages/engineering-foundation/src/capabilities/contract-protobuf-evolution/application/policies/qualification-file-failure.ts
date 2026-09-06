import { ContainedFileReadError } from "../../../../source-inventory/api.js";
import { rejectBufQualificationInput } from "./buf-qualification-input.js";

export function rejectQualificationFileFailure(
  error: unknown,
  input: { readonly label: string; readonly path: string }
): never {
  if (!(error instanceof ContainedFileReadError)) {
    throw error;
  }
  rejectBufQualificationInput(
    error.failure === "symlink" || error.failure === "escape"
      ? "BUF_QUALIFICATION_PATH_UNSAFE"
      : "BUF_QUALIFICATION_INPUT_UNAVAILABLE",
    `${input.label} is unavailable, unsafe, or changed while reading: ${input.path}.`
  );
}
