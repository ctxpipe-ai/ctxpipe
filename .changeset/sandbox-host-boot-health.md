---
"@ctxpipe/aws-cdk": patch
---

Fix the boot of the sandbox host, which made a fresh deploy fail at the sandbox host Auto Scaling group. The host firewall refused the replies to the host's own check of Agent Vault, and that check did not retry a connection reset while Agent Vault starts. The host now refuses only new connections from the Agent Vault network, and the checks retry every error.

Sandboxes can now reach the Agent Vault proxy (TCP 14322) on the host. Before this fix, the host firewall refused that connection.
