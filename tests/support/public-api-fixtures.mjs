import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { stringify as stringifyYaml } from "yaml";

import { promoteArchitectureDecisionBaseline } from "../../packages/engineering-foundation/dist/capabilities/governance-architecture-decisions/module.js";

export const GOVERNANCE_CONFIG_PATH =
  "architecture/foundation/governance-architecture-decisions.yaml";
export const ACCEPTED_DECISION_BASELINE_PATH =
  "architecture/decisions/accepted-decisions.json";

export const ROOT_STABLE_ITEM = Object.freeze({
  canonicalReference: "@fixture/public-api!stable:function(1)",
  kind: "Function",
  parentReference: "@fixture/public-api!",
  parentKind: "EntryPoint",
  signature: "export declare function stable(value: string): string;"
});

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function v2Baseline(localItem = ROOT_STABLE_ITEM) {
  return {
    schemaVersion: 2,
    packageName: "@fixture/public-api",
    packageVersion: "1.2.3",
    extractorVersion: "7.58.12",
    entrypoints: [
      { exportPath: ".", items: [ROOT_STABLE_ITEM] },
      { exportPath: "./local-mode", items: [localItem] }
    ]
  };
}

export async function writeGovernedDecisionEvidence(
  consumerRoot,
  decisionId = "ADR-0001"
) {
  const number = decisionId.slice("ADR-".length);
  const slug = `${number}-approve-public-api-break`;
  const decisionPath = `docs/decisions/${slug}.md`;
  await mkdir(join(consumerRoot, "architecture", "foundation"), { recursive: true });
  await writeFile(
    join(consumerRoot, GOVERNANCE_CONFIG_PATH),
    stringifyYaml({
      schemaVersion: 1,
      adrRoots: ["docs/decisions"],
      index: {
        path: "docs/decisions/README.md",
        sections: {
          proposed: "Proposed",
          accepted: "Accepted",
          superseded: "Superseded"
        }
      },
      acceptedBaselinePath: ACCEPTED_DECISION_BASELINE_PATH
    }, { lineWidth: 0 }),
    "utf8"
  );
  await mkdir(join(consumerRoot, "docs", "decisions"), { recursive: true });
  await writeFile(
    join(consumerRoot, "docs", "decisions", "README.md"),
    `# Architecture Decisions\n\n## Proposed\n\n## Accepted\n\n- [${decisionId}: Approve public API break](${slug}.md)\n\n## Superseded\n`,
    "utf8"
  );
  await writeFile(
    join(consumerRoot, decisionPath),
    `---\nid: ${decisionId}\nstatus: accepted\nsupersedes: []\nsuperseded_by: []\n---\n\n# ${decisionId}: Approve public API break\n\nThe breaking package API change is explicitly reviewed.\n`,
    "utf8"
  );
  await promoteArchitectureDecisionBaseline({
    consumerRoot,
    configPath: GOVERNANCE_CONFIG_PATH
  });
  return Object.freeze({ decisionId, decisionPath });
}

export async function configureV2PublicApiFixture(consumerRoot) {
  const packageDirectory = join(consumerRoot, "packages", "library");
  const configPath = join(
    consumerRoot,
    "architecture",
    "foundation",
    "public-api-compatibility.yaml"
  );
  await writeFile(
    join(packageDirectory, "dist", "local-mode.d.ts"),
    "export declare function stable(value: string): string;\n",
    "utf8"
  );
  await writeFile(
    join(packageDirectory, "tsconfig.json"),
    `${JSON.stringify({
      compilerOptions: {
        module: "NodeNext",
        moduleResolution: "NodeNext",
        strict: true,
        target: "ES2024"
      },
      include: ["dist/*.d.ts"]
    }, null, 2)}\n`,
    "utf8"
  );
  await writeFile(
    join(packageDirectory, "package.json"),
    `${JSON.stringify({
      name: "@fixture/public-api",
      version: "1.2.3",
      type: "module",
      exports: {
        ".": { types: "./dist/index.d.ts" },
        "./local-mode": { types: "./dist/local-mode.d.ts" }
      }
    }, null, 2)}\n`,
    "utf8"
  );
  await writeFile(
    configPath,
    stringifyYaml({
      schemaVersion: 2,
      acceptedDecisionBaselinePath: "architecture/decisions/accepted-decisions.json",
      changesetDirectory: ".changeset",
      packages: [
        {
          packageName: "@fixture/public-api",
          packageRoot: "packages/library",
          manifestPath: "packages/library/package.json",
          entrypoints: [
            {
              exportPath: "./local-mode",
              declarationEntryPoint: "packages/library/dist/local-mode.d.ts"
            },
            {
              exportPath: ".",
              declarationEntryPoint: "packages/library/dist/index.d.ts"
            }
          ],
          nonTypeExports: [],
          tsconfigPath: "packages/library/tsconfig.json",
          releasedBaselinePath: "architecture/public-api/public-api.json",
          approvedBreakingChanges: []
        }
      ]
    }, { lineWidth: 0 }),
    "utf8"
  );
  await writeFile(
    join(consumerRoot, "architecture", "public-api", "public-api.json"),
    `${JSON.stringify(v2Baseline(), null, 2)}\n`,
    "utf8"
  );
  return configPath;
}
