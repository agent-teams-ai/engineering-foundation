---
"@agent-teams/repository-mutation": patch
---

Fix known-file transaction Plan compilation to reject every ancestor/descendant path relationship, not just adjacent pairs after sorting. A sibling path (for example \`managed-other\`) sorting between an ancestor (\`managed\`) and its true descendant (\`managed/child.txt\`) previously let the conflicting Plan through undetected.
