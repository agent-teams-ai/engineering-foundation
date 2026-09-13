import { Extractor, ExtractorConfig, ExtractorLogLevel, type CompilerState, type IExtractorInvokeOptions, type ExtractorResult } from "@microsoft/api-extractor";

/** Shared mechanics only. Callers retain independent admission and model-load gates. */
export function preparePublicApiExtractor(input: {
  readonly packageRoot: string;
  readonly entryPointPath: string;
  readonly tsconfigPath: string;
  readonly manifestPath: string;
  readonly apiJsonPath: string;
  readonly includeForgottenExports: boolean;
  readonly untrimmedObservation?: boolean;
  readonly tsdocConfigFile?: Parameters<typeof ExtractorConfig.prepare>[0]["tsdocConfigFile"];
}): ExtractorConfig {
  return ExtractorConfig.prepare({
    configObject: {
      projectFolder: input.packageRoot,
      mainEntryPointFilePath: input.entryPointPath,
      compiler: { tsconfigFilePath: input.tsconfigPath },
      apiReport: { enabled: false },
      docModel: {
        enabled: true,
        apiJsonFilePath: input.apiJsonPath,
        includeForgottenExports: input.includeForgottenExports,
        ...(input.untrimmedObservation === true ? { releaseTagsToTrim: [] } : {})
      },
      dtsRollup: { enabled: false },
      tsdocMetadata: { enabled: false },
      newlineKind: "lf",
      testMode: true,
      messages: {
        compilerMessageReporting: {
          default: { logLevel: ExtractorLogLevel.Error }
        },
        extractorMessageReporting: {
          default: { logLevel: ExtractorLogLevel.Warning },
          "ae-forgotten-export": { logLevel: ExtractorLogLevel.Error },
          "ae-missing-release-tag": { logLevel: ExtractorLogLevel.None },
          "ae-undocumented": { logLevel: ExtractorLogLevel.None }
        },
        tsdocMessageReporting: {
          default: { logLevel: ExtractorLogLevel.Warning }
        }
      }
    },
    ...(input.tsdocConfigFile === undefined ? {} : { tsdocConfigFile: input.tsdocConfigFile }),
    configObjectFullPath: undefined,
    packageJsonFullPath: input.manifestPath,
    projectFolderLookupToken: input.packageRoot
  });
}

/** Keep invocation mechanics identical; admission and model loading stay with each caller. */
export function invokePublicApiExtractor(
  config: ExtractorConfig,
  compilerState: CompilerState,
  messageCallback: NonNullable<IExtractorInvokeOptions["messageCallback"]>
): ExtractorResult {
  return Extractor.invoke(config, {
    compilerState, localBuild: true, showVerboseMessages: false, messageCallback
  });
}
