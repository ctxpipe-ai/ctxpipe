---
"@ctxpipe/aws-cdk": patch
---

Optional `GITHUB_AUTHORIZE_URL` and `GITHUB_REDIRECT_URI` let an OAuth forwarder serve the authorize step and the callback of GitHub sign-in and of the installation proof. Set both or neither. Unset, ctxpipe uses GitHub's authorize URL and `{AUTH_BASE_URL}/.auth/api/v1/auth/callback/github`, as before.
