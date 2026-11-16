---
"@ctxpipe/aws-cdk": patch
---

Workspaces: the Add repositories dialog shows each repository that ctxpipe can read. A repository that the Workspace links already is disabled, with "In this Workspace". "Give ctxpipe access on GitHub" opens the GitHub access page in a popup. When the popup closes, the dialog selects each new repository, and one press opens the pull request. After an access change on GitHub, the setup page says "GitHub access updated" and does not show the first-install wizard. For a self-hosted GitHub App, keep "Redirect on update" on, so that GitHub closes the popup after a save. There is nothing new to configure.
