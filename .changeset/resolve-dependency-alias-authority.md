---
"@agent-teams/engineering-foundation": patch
---

Keep npm alias import slots, target identities, catalog provenance and effective versions distinct when checking dependency declarations and source imports. Apply development-only and reserved-scope restrictions to alias targets without relaxing exact-version or declaration requirements.

Preserve Node self-reference precedence and valid registry range whitespace. Malformed aliases cannot grant dependency authority. Existing `allow.packages` permissions continue to name import slots.
