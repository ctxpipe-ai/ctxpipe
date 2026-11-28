---
"@ctxpipe/aws-cdk": patch
---

feature: Optional `GITHUB_WEB_URL` and `GITHUB_REDIRECT_URI` let a forwarder serve the GitHub pages of the deployment's App and its callback: the authorize page of GitHub sign-in and of the installation proof, the App's install page, and the OAuth callback. Set both or neither. Unset, ctxpipe uses `https://github.com` and `{AUTH_BASE_URL}/.auth/api/v1/auth/callback/github`, as before. `GITHUB_WEB_URL` replaces `GITHUB_AUTHORIZE_URL`, which no release had.
