import { rm } from "node:fs/promises";

import { PUBLISHABLE_PACKAGES } from "./publishable-packages.mjs";

await Promise.all(
  PUBLISHABLE_PACKAGES.flatMap((releasePackage) => [
    rm(new URL(`../${releasePackage.root}/dist`, import.meta.url), {
      force: true,
      recursive: true,
    }),
    rm(new URL(`../${releasePackage.root}/LICENSE`, import.meta.url), {
      force: true,
    }),
    rm(new URL(`../${releasePackage.root}/tsconfig.tsbuildinfo`, import.meta.url), {
      force: true,
    }),
  ]),
);
