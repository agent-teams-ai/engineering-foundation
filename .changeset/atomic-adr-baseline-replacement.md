---
"@agent-teams/engineering-foundation": patch
"@agent-teams/repository-mutation": minor
---

Coordinate ADR baseline promotion with the existing cooperative repository-root mutation lease. Use exclusively owned sibling temporary files, bind physical root and parent identities, preserve conflicting mutation evidence, and report failures without hiding write, close, cleanup or lease-release errors. Expose the existing evidence-retention helper and a narrow Node atomic replacement resource contract through Repository Mutation's Node adapter API. Physical root, parent and temporary identities stay with the existing mutation owner.
