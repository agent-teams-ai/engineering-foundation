import { normalize, resolve, sep } from "node:path";
import {
  nativeScriptEntrypoint,
  qualitySourceLanguage,
  executesScript,
  assetValidatorDeclaration,
  executesAssetValidator,
  type QualityCoverageProfile,
  type QualityCoverageObservation,
  type QualityFileReader,
} from "../api.js";
import { invalidQualityInput } from "./profile-input.js";

interface QualityGateMappingInput {
  readonly consumerRoot: string;
  readonly profile: QualityCoverageProfile;
  readonly scripts: Readonly<Record<string, string>>;
  readonly readFile: QualityFileReader;
}

export function nativeScriptPath(command: string | undefined): string | undefined {
  const path = nativeScriptEntrypoint(command);
  return path === undefined ? undefined : normalize(path).split(sep).join("/");
}

async function requireReadableQualityFile(
  readFile: QualityFileReader,
  consumerRoot: string,
  path: string,
  failure: string,
): Promise<void> {
  try {
    await readFile({
      root: consumerRoot,
      candidate: resolve(consumerRoot, path),
      maxBytes: 2 * 1024 * 1024,
    });
  } catch {
    invalidQualityInput(failure);
  }
}

export async function readNativeGateMappings(
  input: QualityGateMappingInput,
  boundaries: readonly { readonly id: string }[],
  sources: QualityCoverageObservation["sources"],
) {
  return Promise.all(
    (input.profile.nativeChecks ?? []).map(async (mapping) => {
      if (!boundaries.some(({ id }) => id === mapping.boundaryId)) {
        invalidQualityInput(`Native gate names an unknown source boundary: ${mapping.boundaryId}.`);
      }
      if (
        !sources.some(
          (source) =>
            qualitySourceLanguage(source.path) === "native" &&
            source.owners.includes(mapping.boundaryId),
        )
      ) {
        invalidQualityInput(`Native gate has no current native source: ${mapping.boundaryId}.`);
      }
      const command = input.scripts[mapping.script];
      const scriptPath = nativeScriptPath(command);
      let reached = false;
      if (command !== undefined && scriptPath !== undefined) {
        await requireReadableQualityFile(
          input.readFile,
          input.consumerRoot,
          scriptPath,
          `Native gate script is missing or outside the consumer: ${mapping.script}.`,
        );
        reached = executesScript(
          input.scripts,
          input.profile.scripts.full,
          mapping.script,
          command,
        );
      }
      return { ...mapping, reached };
    }),
  );
}

export async function readAssetGateMappings(
  input: QualityGateMappingInput,
  sources: QualityCoverageObservation["sources"],
) {
  return Promise.all(
    (input.profile.assets ?? []).map(async (mapping) => {
      const source = sources.find(({ path }) => path === mapping.path);
      if (
        source === undefined ||
        source.owners.length !== 1 ||
        source.owners[0] !== mapping.boundaryId
      ) {
        invalidQualityInput(`Asset must have its exact current semantic owner: ${mapping.path}.`);
      }
      await requireReadableQualityFile(
        input.readFile,
        input.consumerRoot,
        mapping.path,
        `Asset is missing, unreadable or outside the consumer: ${mapping.path}.`,
      );
      const validatorFiles = assetValidatorDeclaration(input.scripts[mapping.script]);
      for (const path of validatorFiles ?? []) {
        await requireReadableQualityFile(
          input.readFile,
          input.consumerRoot,
          path,
          `Asset validator script is missing, unreadable or outside the consumer: ${mapping.script} (${path}).`,
        );
      }
      return {
        ...mapping,
        reached: executesAssetValidator(input.scripts, input.profile.scripts.full, mapping.script),
      };
    }),
  );
}
