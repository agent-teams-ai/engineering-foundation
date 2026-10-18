---
"@agent-teams/feature-module-standard": minor
---

Add the opt-in Feature Module Standard package: a pure kernel that checks the
declared structure of one production module (feature tree and sub-features,
visibility, edge classes, composition contracts, republication, layer direction,
cycles, test ownership and growth metrics) and the shared conformance fixtures
that every adopting checker runs. A `./node` runner reads the declared roots
through the Foundation source graph and reports growth budget warnings; Foundation
`^1.8.0` is an optional peer dependency. Repository policy stays input; the kernel
reads no files and widens no rule.
