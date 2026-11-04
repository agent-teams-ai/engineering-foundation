import { realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { invalidQualityInput, qualityRecord } from "./quality-input-values.js";
import type { QualityResolutionBinding } from "./quality-input-witness.js";

type DataReader = (root: string, path: string) => Promise<unknown>;

function contained(root: string, path: string): boolean {
  const suffix = relative(root, path);
  return suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix);
}

async function existing(path: string): Promise<string | undefined> {
  try {
    return await realpath(path);
  } catch (error) {
    if (error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

function exactTarget(manifest: Record<string, unknown>, subpath: string): string {
  if (manifest["exports"] === undefined) {
    return subpath;
  }
  const exports = qualityRecord(manifest["exports"]);
  const target = exports[subpath];
  if (
    typeof target !== "string" ||
    !target.startsWith("./") ||
    !target.endsWith(".json") ||
    target
      .split("/")
      .slice(1)
      .some((part) => part === "" || part === "." || part === ".." || part === "node_modules") ||
    /[*?%\\]/u.test(target)
  ) {
    invalidQualityInput(
      "Lint JSON package exports require an exact string-valued subpath. Conditional and wildcard exports are unsupported; use an explicit contained JSON path.",
    );
  }
  return target;
}

async function rejectSelfReference(
  root: string,
  issuer: string,
  packageName: string,
  read: DataReader,
  aliases: { path: string; target: string | null }[],
): Promise<void> {
  for (
    let directory = dirname(issuer);
    contained(root, directory);
    directory = dirname(directory)
  ) {
    const manifestPath = join(directory, "package.json");
    const physical = await existing(manifestPath);
    aliases.push({ path: manifestPath, target: physical ?? null });
    if (physical !== undefined) {
      const manifest = qualityRecord(await read(dirname(physical), "package.json"));
      if (manifest["name"] === packageName && manifest["exports"] !== undefined) {
        invalidQualityInput(
          "Self-referencing lint JSON package exports are unsupported; use an explicit contained relative JSON path.",
        );
      }
      return;
    }
    if (directory === root) {
      return;
    }
  }
}

function assertQualityReference(request: string): void {
  if (
    !request.endsWith(".json") ||
    isAbsolute(request) ||
    request.startsWith("#") ||
    request.split("").some((character) => character < " " || character.charCodeAt(0) === 127) ||
    /[\\%?*:]/u.test(request)
  ) {
    invalidQualityInput(
      "Lint configuration references require exact contained JSON paths or exact package subpath exports.",
    );
  }
}

/** Qualify only inert exact JSON references; never reuse Node's opaque resolution cache. */
export async function resolveQualityJsonConfig(input: {
  readonly root: string;
  readonly issuer: string;
  readonly request: string;
  readonly read: DataReader;
  readonly observeBinding: (binding: QualityResolutionBinding) => Promise<void>;
}): Promise<string> {
  const { root, issuer, request, read, observeBinding } = input;
  assertQualityReference(request);
  const aliases: { path: string; target: string | null }[] = [];
  let logicalTarget: string | undefined;
  if (request.startsWith("./") || request.startsWith("../")) {
    logicalTarget = resolve(dirname(issuer), request);
  } else {
    const segments = request.split("/");
    const length = request.startsWith("@") ? 2 : 1;
    const packageName = segments.slice(0, length).join("/");
    const subpath = `./${segments.slice(length).join("/")}`;
    if (
      segments.length <= length ||
      segments.some((segment) => segment === "" || segment === "." || segment === "..")
    ) {
      invalidQualityInput("Lint package references require a canonical JSON subpath.");
    }
    await rejectSelfReference(root, issuer, packageName, read, aliases);
    for (const directory of createRequire(issuer).resolve.paths(request) ?? []) {
      const candidate = join(directory, packageName);
      if (!contained(root, candidate)) {
        continue;
      }
      const physical = await existing(candidate);
      aliases.push({ path: candidate, target: physical ?? null });
      const packageManifest = join(candidate, "package.json");
      const physicalManifest = await existing(packageManifest);
      aliases.push({ path: packageManifest, target: physicalManifest ?? null });
      if (physical === undefined) {
        continue;
      }
      if (!contained(root, physical)) {
        invalidQualityInput("Installed lint configuration escapes the consumer root.");
      }
      const manifest = qualityRecord(await read(physical, "package.json"));
      logicalTarget = resolve(candidate, exactTarget(manifest, subpath));
      break;
    }
  }
  if (logicalTarget === undefined || !contained(root, logicalTarget)) {
    invalidQualityInput(
      "An installed or relative JSON lint configuration is missing or outside the consumer.",
    );
  }
  const target = await existing(logicalTarget);
  if (target === undefined || !contained(root, target)) {
    invalidQualityInput("A JSON lint configuration is missing or escapes the consumer root.");
  }
  await observeBinding({ issuer, request, logicalTarget, aliases, target });
  return target;
}
