---
"@ctxpipe/aws-cdk": patch
---

Fix the boot of the sandbox host. The host firewall refused the replies to the host's own check of Agent Vault, so the boot timed out and the deploy failed at the sandbox host Auto Scaling group. The host now refuses only new connections from the sandbox and Agent Vault networks.
