import type {
  EffectiveInstructionDirectoryObservation,
  EffectiveInstructionDiscovery
} from "../model/effective-instructions.js";

export interface EffectiveInstructionsReader {
  discover(input: {
    readonly consumerRoot: string;
    readonly targetPath: string;
    readonly signal?: AbortSignal;
  }): Promise<EffectiveInstructionDiscovery>;

  readDirectory(input: {
    readonly consumerRoot: string;
    readonly directory: string;
    readonly readSelectedBytes: boolean;
    readonly signal?: AbortSignal;
  }): Promise<EffectiveInstructionDirectoryObservation>;
}
