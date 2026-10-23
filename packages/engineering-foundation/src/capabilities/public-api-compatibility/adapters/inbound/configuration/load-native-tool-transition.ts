import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { PublicApiRepositoryEvidence } from "../../../application/ports/public-api-evidence.js";
import {
  nativeTransitionError as fail,
  type NativeMigrationReview,
} from "../../../application/model/native-tool-transition.js";
export type NativeTransitionSchemaAssertion = (
  id: "package-public-api-native-transition/v1",
  value: unknown,
  phase: string,
) => Promise<void>;
interface Request {
  readonly schemaVersion: 1;
  readonly kind: "foundation:public-api-native-transition:1";
  readonly releasedRoot: string;
  readonly review: NativeMigrationReview;
  readonly packages: readonly {
    readonly packageName: string;
    readonly baselineInputPath: string;
    readonly archivePath: string;
    readonly configPath: string;
  }[];
  readonly configurationFiles: readonly { readonly path: string; readonly inputPath: string }[];
}
function contained(root: string, path: string): boolean {
  const value = relative(root, path);
  return (
    value === "" ||
    (!isAbsolute(value) &&
      value !== ".." &&
      !value.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`))
  );
}
function filePath(path: string): string {
  if (
    path.includes("\\") ||
    isAbsolute(path) ||
    path.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    fail("request input path must be a contained relative path");
  }
  return path;
}
/** Paths identify frozen content only. Registry/GitHub origin and protected
 * release execution are authenticated by the consumer's existing operator. */
export async function loadNativeTransitionRequest(
  consumerRoot: string,
  requestPath: string,
  assertSchema: NativeTransitionSchemaAssertion,
  evidence: PublicApiRepositoryEvidence,
) {
  const source = resolve(requestPath);
  const root = await realpath(dirname(source));
  const bytes = await evidence.files.read({ root, candidate: source, maxBytes: 4 * 1024 * 1024 });
  const text = Buffer.from(bytes).toString("utf8");
  evidence.parseYaml(text, "native-public-api-transition"); // Reject duplicate data keys through the existing strict reader.
  const parsed: unknown = JSON.parse(text);
  await assertSchema(
    "package-public-api-native-transition/v1",
    parsed,
    "native-public-api-transition",
  );
  const request = structuredClone(parsed as Request);
  const releasedRoot = join(root, filePath(request.releasedRoot));
  if (
    !(await lstat(releasedRoot)).isDirectory() ||
    (await evidence.paths.traversesSymbolicLink(root, releasedRoot)) ||
    (await realpath(releasedRoot)) !== releasedRoot
  ) {
    fail("released namespace must be a contained ordinary directory");
  }
  const candidate = await realpath(consumerRoot);
  if (contained(candidate, releasedRoot) || contained(releasedRoot, candidate)) {
    fail("historical and candidate namespaces must not overlap");
  }
  let remainingBytes = 128 * 1024 * 1024;
  const read = async (path: string, maxBytes: number) => {
    const sourcePath = join(root, filePath(path));
    if (contained(candidate, sourcePath)) {
      fail("historical request content cannot come from the candidate namespace");
    }
    if (remainingBytes === 0) {
      fail("historical request input byte budget exceeded");
    }
    const limit = Math.min(maxBytes, remainingBytes);
    const input = await evidence.files.read({ root, candidate: sourcePath, maxBytes: limit });
    if (input.byteLength > limit) {
      fail("historical request input byte budget exceeded");
    }
    remainingBytes -= input.byteLength;
    return input;
  };
  const packages = [];
  for (const row of request.packages) {
    packages.push({
      packageName: row.packageName,
      baselineBytes: await read(row.baselineInputPath, 32 * 1024 * 1024),
      archiveBytes: await read(row.archivePath, 8 * 1024 * 1024),
      configBytes: await read(row.configPath, 32 * 1024 * 1024),
    });
  }
  const configurationFiles = [];
  for (const row of request.configurationFiles) {
    configurationFiles.push({
      path: filePath(row.path),
      bytes: await read(row.inputPath, 32 * 1024 * 1024),
    });
  }
  return { releasedRoot, review: request.review, packages, configurationFiles };
}
