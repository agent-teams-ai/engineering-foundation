---
"@agent-teams/feature-module-standard": patch
---

Issue a new patch artifact for source provenance qualification after the 0.4.0
registry attestation exposed the npm publish statement without the required SLSA
statement. The public API and runtime behavior are unchanged. The earlier
immutable version remains unqualified; the new artifact must pass the ordinary
protected release and cryptographic provenance checks before admission.
