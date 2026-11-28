# Generated SDK output observation

Development-only candidate entrypoint. The existing native generator and the
consumer's reviewed generation config remain the only generation authority.
The expected and regenerated directories must contain only the complete
generated file set, and must be distinct absolute directories.

```ts
import { compareGeneratedSdkDirectories } from "@agent-teams/engineering-foundation/sdk-generation";

const result = await compareGeneratedSdkDirectories({
  expectedRoot,
  regeneratedRoot,
});
if (
  result.generationDrift.expectedGeneratedOutputDigest !==
  result.generationDrift.observedGeneratedOutputDigest
) {
  throw new Error("Generated SDK differs: " + JSON.stringify(result));
}
```

The result identifies missing, unexpected and changed paths and supplies
independently observed SHA-256 digests for the existing Protobuf generation
drift declaration. No files are written, no processes are started, and no
release baseline is promoted. The tool does not prove generation tool
identity, schema compatibility, or business semantics. Use the existing
Buf qualifier, consumer native generators and language tests for those
claims. The consumer must stage complete reviewed inputs, verify tools and
keep the generation/check route read-only. Do not use this entrypoint from
product runtime. Only the supported exact packed or released coordinate may
be consumed. No publication or real-consumer migration is claimed yet.
