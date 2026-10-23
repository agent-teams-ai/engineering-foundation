import { join } from "node:path";
export function createFixtureEnvironment() {
  const saved = new Map<string, string | undefined>();
  return {
    setEnv(key: string, value: string): void {
      saved.set(key, process.env[key]);
      process.env[key] = value;
    },
    restoreEnvironment(): void {
      for (const [key, value] of saved) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    },
  };
}
export function configureFixtureStore({
  setEnv,
  registry,
  disposable,
  isolatedStore,
}: {
  setEnv: (key: string, value: string) => void;
  registry: { base: string };
  disposable: string;
  isolatedStore: boolean;
}) {
  setEnv("npm_config_registry", registry.base);
  setEnv("pnpm_config_registry", registry.base);
  const store = isolatedStore
    ? join(disposable, "store")
    : (process.env.npm_config_store_dir ?? join(disposable, "store"));
  setEnv("npm_config_store_dir", store);
  setEnv("pnpm_config_store_dir", store);
  // Reused loopback ports must not reuse metadata for different same-version TEST archives.
  // Retrieval cases keep metadata in their independently copyable fixture store.
  const cache = isolatedStore ? store : join(disposable, "cache");
  setEnv("npm_config_cache_dir", cache);
  setEnv("pnpm_config_cache_dir", cache);
  setEnv("CI", "true");
}
