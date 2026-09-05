import { digest } from "../application/runtime.js";
import { lstat, mkdir, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve as resolvePath, sep } from "node:path";
import { fileURLToPath } from "node:url";

const MAX_QUALIFICATION_AUTHORITY_BYTES = 8 * 1024 * 1024;

export async function readContainedBoundedFile(
  root: string,
  repositoryPath: string,
  label: string,
  maximumBytes = MAX_QUALIFICATION_AUTHORITY_BYTES
): Promise<{ readonly bytes: Buffer; readonly digest: `sha256:${string}`; readonly path: string }> {
  if (repositoryPath.startsWith("/") || repositoryPath.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error(`${label} must be one canonical repository-relative path.`);
  }
  const absolute = resolvePath(root, repositoryPath);
  const relativePath = relative(root, absolute);
  if (relativePath === ".." || relativePath.startsWith(`..${sep}`)) {
    throw new Error(`${label} escapes the consumer root.`);
  }
  const metadata = await lstat(absolute);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || metadata.size > maximumBytes) {
    throw new Error(`${label} must be one bounded, non-hardlinked regular file.`);
  }
  const physical = await realpath(absolute);
  if (physical !== absolute) {
    throw new Error(`${label} must not traverse a symlink.`);
  }
  const bytes = await readFile(physical);
  const after = await lstat(absolute);
  if (!after.isFile() || after.isSymbolicLink() || after.nlink !== 1 ||
    after.dev !== metadata.dev || after.ino !== metadata.ino || after.size !== metadata.size ||
    bytes.byteLength !== metadata.size || bytes.byteLength > maximumBytes) {
    throw new Error(`${label} changed during its bounded read.`);
  }
  return Object.freeze({ bytes, digest: digest(bytes), path: repositoryPath });
}

export async function bootstrapQualificationInstallation(consumerRoot: string, rewriteManifest: boolean): Promise<{
  readonly docsVersion: string;
  readonly authoringVersion: string;
  readonly mutationVersion: string;
}> {
  const docsManifestPath = fileURLToPath(new URL("../../../../package.json", import.meta.url));
  const authoringManifestPath = fileURLToPath(import.meta.resolve("@agent-teams/document-authoring/package.json"));
  const mutationManifestPath = fileURLToPath(import.meta.resolve("@agent-teams/repository-mutation/package.json"));
  const [docsManifest, authoringManifest, mutationManifest, consumerManifest] = await Promise.all([
    readFile(docsManifestPath, "utf8").then((source) => JSON.parse(source) as { readonly version: string }),
    readFile(authoringManifestPath, "utf8").then((source) => JSON.parse(source) as { readonly version: string }),
    readFile(mutationManifestPath, "utf8").then((source) => JSON.parse(source) as { readonly version: string }),
    readFile(join(consumerRoot, "package.json"), "utf8").then((source) => JSON.parse(source) as Record<string, unknown>)
  ]);
  if (rewriteManifest) {
    await writeFile(join(consumerRoot, "package.json"), `${JSON.stringify({
      ...consumerManifest,
      devDependencies: {
        ...((typeof consumerManifest["devDependencies"] === "object" && consumerManifest["devDependencies"] !== null)
          ? consumerManifest["devDependencies"] as Record<string, unknown>
          : {}),
        "@agent-teams/docs-protocol": docsManifest.version,
        "@agent-teams/document-authoring": authoringManifest.version,
        "@agent-teams/repository-mutation": mutationManifest.version
      }
    }, null, 2)}\n`, "utf8");
  } else {
    const dependencies = typeof consumerManifest["devDependencies"] === "object" &&
      consumerManifest["devDependencies"] !== null
      ? consumerManifest["devDependencies"] as Record<string, unknown>
      : {};
    if (dependencies["@agent-teams/docs-protocol"] !== docsManifest.version ||
      dependencies["@agent-teams/document-authoring"] !== authoringManifest.version ||
      dependencies["@agent-teams/repository-mutation"] !== mutationManifest.version) {
      throw new Error("Qualification requires the exact executing portable packages in devDependencies.");
    }
  }
  const scope = join(consumerRoot, "node_modules", "@agent-teams");
  await mkdir(scope, { recursive: true });
  await Promise.all([
    symlink(dirname(docsManifestPath), join(scope, "docs-protocol"), process.platform === "win32" ? "junction" : "dir"),
    symlink(dirname(authoringManifestPath), join(scope, "document-authoring"), process.platform === "win32" ? "junction" : "dir"),
    symlink(dirname(mutationManifestPath), join(scope, "repository-mutation"), process.platform === "win32" ? "junction" : "dir")
  ]);
  await writeFile(join(consumerRoot, ".agent-teams-document-authoring-qualification-fixture.json"), `${JSON.stringify({
    schemaVersion: 1,
    kind: "agent-teams-document-authoring-qualification-fixture",
    consumerRoot: await realpath(consumerRoot)
  })}\n`, "utf8");
  return Object.freeze({
    docsVersion: docsManifest.version,
    authoringVersion: authoringManifest.version,
    mutationVersion: mutationManifest.version
  });
}
