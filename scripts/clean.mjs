import { rm } from "node:fs/promises";

await Promise.all([
  rm(new URL("../packages/engineering-foundation/dist", import.meta.url), {
    force: true,
    recursive: true
  }),
  rm(new URL("../packages/engineering-foundation/LICENSE", import.meta.url), {
    force: true
  }),
  rm(
    new URL(
      "../packages/engineering-foundation/tsconfig.tsbuildinfo",
      import.meta.url
    ),
    { force: true }
  )
]);
