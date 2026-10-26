import { resolvePackageExport } from "../../../workspace-inventory/api.js";
import { parseStaticHostCommand } from "../../configuration-input/application/static-host-command.js";
export { assertRepositoryRelativePath } from "../../../source-inventory/api.js";

/** Normalized selectors after strict profile validation; no formatter support table. */
export interface FormatCoverageSelection {
  readonly maintainedRoots: readonly string[];
  readonly routes: readonly {
    readonly authority: string;
    readonly files: readonly string[];
    readonly trees: readonly { readonly path: string; readonly suffixes: readonly string[] }[];
  }[];
}

const inside = (path: string, root: string): boolean => path.startsWith(`${root}/`);

/** Classification is static scope evidence, never proof that an authority ran. */
export function classifyFormatCoverage(
  filePaths: readonly string[],
  selection: FormatCoverageSelection,
): {
  readonly formatFiles: readonly string[];
  readonly authorityFiles: ReadonlyMap<string, readonly string[]>;
  readonly problems: readonly string[];
} {
  const paths = [...new Set(filePaths)].toSorted();
  const problems: string[] = [];
  for (const root of selection.maintainedRoots) {
    if (!paths.some((path) => inside(path, root))) problems.push(`empty-root:${root}`);
  }
  for (const route of selection.routes) {
    for (const path of route.files) {
      if (!paths.includes(path)) problems.push(`stale-file:${path}`);
    }
    for (const tree of route.trees) {
      if (
        !paths.some(
          (path) =>
            inside(path, tree.path) && tree.suffixes.some((suffix) => path.endsWith(suffix)),
        )
      ) {
        problems.push(`empty-authority-tree:${tree.path}`);
      }
    }
  }
  const formatFiles: string[] = [];
  const authorityFiles = new Map<string, string[]>();
  for (const path of paths) {
    const routes = selection.routes.filter(
      (route) =>
        route.files.includes(path) ||
        route.trees.some(
          (tree) =>
            inside(path, tree.path) && tree.suffixes.some((suffix) => path.endsWith(suffix)),
        ),
    );
    if (routes.length > 1) {
      problems.push(`ambiguous-authority:${path}`);
      continue;
    }
    const route = routes[0];
    if (route !== undefined) {
      const files = authorityFiles.get(route.authority) ?? [];
      files.push(path);
      authorityFiles.set(route.authority, files);
    } else if (
      !path.includes("/") ||
      selection.maintainedRoots.some((root) => inside(path, root))
    ) {
      formatFiles.push(path);
    } else {
      problems.push(`unclassified-family:${path}`);
    }
  }
  if (paths.length === 0) problems.push("empty-inventory");
  return { formatFiles, authorityFiles, problems: problems.toSorted() };
}

/** A declaration, never a certificate of the validator's implementation or effects. */
export function formatAuthorityEntrypoint(command: string | undefined): string | undefined {
  const parsed = parseStaticHostCommand(command);
  return parsed !== undefined &&
    parsed.entrypoint.startsWith("scripts/") &&
    (parsed.arguments.length === 0 ||
      (parsed.arguments.length === 1 && parsed.arguments[0] === "--check"))
    ? parsed.entrypoint
    : undefined;
}

/** Reuse the source owner's ESM target rules; do not implement another resolver. */
export function formatPublicEntryTarget(target: string): string | undefined {
  return resolvePackageExport([{ subpath: ".", availability: "available", target }], ".", "import")
    .targetPath;
}
