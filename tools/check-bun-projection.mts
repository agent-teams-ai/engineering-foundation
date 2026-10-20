import { assertBunRootProjection } from "./runtime-policy.mts";

await assertBunRootProjection(process.cwd());
process.stdout.write("Bun root projection matches pnpm-workspace.yaml.\n");
