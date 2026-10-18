---
"@agent-teams/engineering-foundation": minor
---

Use exact TypeScript 7.0.2 for public API extraction, independently collected
compiler diagnostics, and rich declaration-graph observation. Keep the existing
Microsoft API model, public ports, schemas, comparison policies, and release-owned
baseline guards. Remove the old API Extractor runtime and its embedded compiler.

The new extractor identity is `typescript-native/7.0.2`. Existing baselines remain
immutable and require an explicitly reviewed, release-owned tool migration before
consumer adoption; identical declarations do not waive the identity mismatch.
This changeset does not authorize baseline replacement or publication. See the
native adapter migration section in `docs/architecture/public-api-compatibility.md`.
