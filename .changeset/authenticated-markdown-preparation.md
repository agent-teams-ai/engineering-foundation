---
"@agent-teams/document-authoring": patch
---

Bundle the private Markdown parser adapter when preparing published packages, reducing installation dependencies without replacing the maintained parser or changing public types. Authenticate bundled code against original lockfile archives and retain upstream notices, a CycloneDX SBOM, and reproducible build evidence. Source dependencies remain explicit; clean pack, registry qualification, release, and package checks use the same disposable distribution projection.
