---
"@ctxpipe/aws-cdk": minor
---

This release adds the chat sandbox host. It is on by default. To turn it off, set `sandboxHost: { enabled: false }`. Chat is off without the host.

The default size (`size: "small"`) is one `t4g.medium` instance. It costs about $28 a month in us-east-1. The `medium` and `large` sizes cost about $54 and $107 a month.

The first `cdk deploy` adds the host. It replaces nothing that holds data.

The migrate task now runs the single migrate entry point. This entry point makes `ctxpipe_app` ready, applies the expand-only SQL, and runs the backfills.

Before you upgrade, take a database snapshot. To roll back, restore the previous package version and the owner `DATABASE_URL` secret. See the Upgrades page.
