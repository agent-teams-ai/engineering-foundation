import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
export async function writeScaffoldingTypeConsumer(consumerRoot: string): Promise<void> {
  const typeConsumerRoot = join(consumerRoot, "type-consumer");
  await mkdir(typeConsumerRoot, { recursive: true });
  await writeFile(
    join(typeConsumerRoot, "scaffold-target-catalog.ts"),
    [
      'import type { ScaffoldTargetCatalog } from "@agent-teams/engineering-foundation/scaffolding";',
      "",
      "export const schemaShapedTargetCatalog = {",
      "  version: 1,",
      "  packages: [",
      "    {",
      '      id: "testing.generated",',
      '      role: "testing-package",',
      '      path: "packages/testing/generated",',
      '      package_name: "@fixture/generated",',
      '      owner_document: "ADR-0001"',
      "    }",
      "  ]",
      "} satisfies ScaffoldTargetCatalog;",
      "",
    ].join("\n"),
    "utf8",
  );
}
