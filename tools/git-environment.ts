/** Repository selectors belong to the Git operation, never to its ordinary children. */
const REPOSITORY_SELECTORS = new Set([
  "GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_QUARANTINE_PATH",
  "GIT_NAMESPACE", "GIT_SHALLOW_FILE", "GIT_REPLACE_REF_BASE",
  "GIT_CEILING_DIRECTORIES", "GIT_DISCOVERY_ACROSS_FILESYSTEM", "GIT_IMPLICIT_WORK_TREE",
  "GIT_PREFIX", "GIT_INTERNAL_SUPER_PREFIX",
  "GIT_CONFIG", "GIT_CONFIG_COUNT", "GIT_CONFIG_PARAMETERS"
]);

/** Preserve transport, authentication, identity and normal system/global configuration. */
export function withoutGitRepositorySelectors(
  environment: Readonly<NodeJS.ProcessEnv> = process.env
): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(environment).filter(([key]) =>
    !REPOSITORY_SELECTORS.has(key) && !/^GIT_CONFIG_(?:KEY|VALUE)_\d+$/u.test(key)
  ));
}
