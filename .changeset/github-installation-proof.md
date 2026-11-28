---
"@ctxpipe/aws-cdk": patch
---

improvement: GitHub connect no longer needs a linked GitHub account. When the linked account does not show access to the installation, the user authorizes the GitHub App one time, and ctxpipe makes no account link. `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` must be the client ID and secret of the GitHub App in `GITHUB_APP_ID`, and the App must list the callback URL `{AUTH_BASE_URL}/.auth/api/v1/auth/callback/github`.
