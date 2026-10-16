import type { FeatureModuleInput, LayerRole } from '../../feature-model/domain/model.js';

/** The default layout of the standard: `<features root>/<feature>/<role directory>`, sub-features in `features/`. */
export type DirectoryLayout = Readonly<{
  featuresRoot: string;
  files: readonly string[];
  /** Role of a directory directly below a feature root, by name. */
  roleDirectories: Readonly<Record<string, LayerRole>>;
  /** Declared sub-feature roots. Without them only the top-level features exist. */
  subFeatureRoots?: readonly string[];
}>;

/**
 * Builds the profile-declared structure of the kernel input for a tree that follows the default layout. A repository whose
 * layout is not the default declares `featureRoots` and `roleRoots` itself instead.
 */
export function inferDirectoryLayout(layout: DirectoryLayout): Pick<FeatureModuleInput, 'featureRoots' | 'featuresRoots' | 'roleRoots'> {
  const prefix = `${layout.featuresRoot}/`;
  const top = new Set<string>();
  for (const file of layout.files) {
    const rest = file.startsWith(prefix) ? file.slice(prefix.length).split('/') : [];
    if (rest.length >= 2) { top.add(`${layout.featuresRoot}/${rest[0] ?? ''}`); }
  }
  const featureRoots = [...top, ...(layout.subFeatureRoots ?? [])];
  return {
    featureRoots,
    featuresRoots: [layout.featuresRoot],
    roleRoots: featureRoots.flatMap((root) => Object.entries(layout.roleDirectories)
      .map(([name, role]): { root: string; role: LayerRole } => ({ root: `${root}/${name}`, role }))),
  };
}
