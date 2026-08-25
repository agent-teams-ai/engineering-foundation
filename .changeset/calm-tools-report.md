---
"@agent-teams/docs-protocol": patch
---

Classify machine failures with a closed, stable cause kind while redacting raw
errors, paths, repository bytes, and secrets. Propagate qualification
cancellation through the disposable crash child and await it settling on spawn
error or close as well as exit, preventing cleanup from hanging and ensuring
its temporary inputs are removed.
