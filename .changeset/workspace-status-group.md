---
"@ctxpipe/aws-cdk": patch
---

Workspace settings now starts with a Status group. Its first line tells if you must act: "Needs you", "Working" (no action needed), or "Up to date". Upgrades that wait for a person show under "Needs you". Upgrades that ctxpipe works on show under "Working now", with the spend so far of a re-ingestion. History shows the count of applied upgrades and the date of the last one.
