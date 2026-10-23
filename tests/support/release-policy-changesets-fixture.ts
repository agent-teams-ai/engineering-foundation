import { NPM_PACKAGE_BOOTSTRAP } from "../../scripts/npm-package-bootstrap.mjs";
import { PUBLISHABLE_PACKAGE_DEPENDENCIES } from "../../scripts/publishable-packages.mjs";
import { docsProtocolMcp } from "./release-policy-identities.ts";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { commandShim } from "./release-publish-policy-fixtures.mjs";
export async function json(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}
export async function changesetsFixture(root: string, foundationName: string) {
  await json(join(root, "package.json"), {
    name: "release-fixture",
    packageManager: "npm@11.19.0",
    private: true,
    workspaces: ["packages/*"],
  });
  await json(join(root, "packages/engineering-foundation/package.json"), {
    name: foundationName,
    publishConfig: { access: "public", registry: "http://127.0.0.1:9/" },
    version: "0.17.0-rc.0",
  });
  await json(join(root, ".changeset/config.json"), {
    access: "public",
    baseBranch: "main",
    changelog: false,
    commit: false,
    fixed: [],
    ignore: [],
    linked: [],
    updateInternalDependencies: "patch",
  });
  await json(join(root, ".changeset/pre.json"), {
    changesets: [],
    initialVersions: {},
    mode: "pre",
    tag: "rc",
  });
  await commandShim(root, "npm", {
    posix:
      '#!/bin/sh\n[ -n "$COMMAND_SHIM_MARKER" ] || exit 97\nprintf \'npm %s\\n\' "$*" >> "$COMMAND_SHIM_MARKER"\nif [ "$1" = profile ]; then printf \'{}\\n\'; exit 0; fi\nif [ "$1" = info ]; then exit 0; fi\nif [ "$1" = publish ]; then printf \'%s\\n\' "$@" > "$PUBLISH_MARKER"; printf \'{"id":"foundation"}\\n\'; exit 0; fi\nexit 1\n',
    windows:
      '@echo off\r\nif not defined COMMAND_SHIM_MARKER exit /b 97\r\n>> "%COMMAND_SHIM_MARKER%" echo npm %*\r\nif /I "%~1"=="profile" goto profile\r\nif /I "%~1"=="info" goto info\r\nif /I "%~1"=="publish" goto publish\r\nexit /b 1\r\n:profile\r\necho {}\r\nexit /b 0\r\n:info\r\nexit /b 0\r\n:publish\r\ntype nul >"%PUBLISH_MARKER%"\r\ncall :recordArgs %*\r\necho {"id":"foundation"}\r\nexit /b 0\r\n:recordArgs\r\nif "%~1"=="" exit /b 0\r\n>>"%PUBLISH_MARKER%" echo(%~1\r\nshift\r\ngoto recordArgs\r\n',
  });
}

export async function writeDocsMcpManifest(root: string, version = docsProtocolMcp.version) {
  await json(join(root, "packages/docs-protocol-mcp/package.json"), {
    name: docsProtocolMcp.name,
    version,
    dependencies: Object.fromEntries(
      (PUBLISHABLE_PACKAGE_DEPENDENCIES as Readonly<Record<string, readonly string[]>>)[
        docsProtocolMcp.name
      ]!.map((name) => [name, "workspace:*"]),
    ),
    publishConfig: { access: "public", provenance: true, registry: NPM_PACKAGE_BOOTSTRAP.registry },
  });
}
