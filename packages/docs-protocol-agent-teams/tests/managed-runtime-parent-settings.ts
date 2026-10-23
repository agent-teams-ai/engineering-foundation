import { join } from "node:path";
export function conflictingParentSettings(
  root: string,
): Readonly<Record<string, string>> & { readonly npm_config_store_dir: string } {
  return {
    NODE_OPTIONS: "--TEST-parent-node-option-must-not-be-forwarded",
    NODE_PATH: join(root, "TEST-parent-module-path"),
    npm_config_node_options: "--TEST-parent-node-option-must-not-be-forwarded",
    npm_config_use_node_version: "99.0.0",
    npm_config_engine_strict: "false",
    NPM_CONFIG_ENGINE_STRICT: "false",
    npm_config_strict_peer_dependencies: "false",
    NPM_CONFIG_STRICT_PEER_DEPENDENCIES: "false",
    npm_config_auto_install_peers: "true",
    npm_config_manage_package_manager_versions: "true",
    npm_config_verify_store_integrity: "false",
    npm_config_ignore_scripts: "false",
    npm_config_offline: "false",
    npm_config_store_dir: join(root, "TEST-parent-pnpm-store"),
    npm_config_userconfig: join(root, "TEST-parent-user.npmrc"),
    npm_config_globalconfig: join(root, "TEST-parent-global.npmrc"),
    TEST_PARENT_ENVIRONMENT_SENTINEL: "TEST-parent-only-value",
  };
}
