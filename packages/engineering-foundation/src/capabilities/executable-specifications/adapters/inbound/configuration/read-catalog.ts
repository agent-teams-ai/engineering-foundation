import { resolve } from "node:path";
import { catalogReadFailure } from "../../../application/configuration-input.js";
import { parseCatalogSource } from "./parse-capability-config.js";

const MAX_CATALOG_BYTES = 4 * 1024 * 1024;

export interface CatalogReaderDependencies {
  readonly readFile: (input: {
    readonly candidate: string;
    readonly maxBytes: number;
    readonly root: string;
  }) => Promise<Buffer>;
}

export async function readCatalog(dependencies: CatalogReaderDependencies, consumerRoot: string, catalogPath: string): Promise<unknown> {
  let bytes: Buffer;
  try {
    bytes = await dependencies.readFile({
      candidate: resolve(consumerRoot, catalogPath),
      maxBytes: MAX_CATALOG_BYTES,
      root: consumerRoot
    });
  } catch (error) {
    catalogReadFailure(error, catalogPath);
  }
  return parseCatalogSource(bytes.toString("utf8"), catalogPath);
}
