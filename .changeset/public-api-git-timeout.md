---
"@agent-teams/engineering-foundation": patch
---

Give the git calls that read repository identity in `package.public-api-compatibility`
a 60 second deadline instead of 10 seconds. A cold Windows runner could exceed ten
seconds and fail with `UNEXPECTED_PROCESS_FAILURE`. On Windows the deadline also covers
the Job Object wrapper (the PowerShell bootstrap with its `Add-Type` C# compilation and the
Node process host), not only git.
