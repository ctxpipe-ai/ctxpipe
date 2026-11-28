---
"@ctxpipe/aws-cdk": patch
---

fix: The sandbox host forwards Agent Vault's proxy port without docker-proxy and without NAT for sandboxes. Agent Vault now sees the address of each sandbox. Before, it saw one address for all sandboxes, so 50 failed proxy logins from one sandbox blocked the proxy for all sandboxes for up to 5 minutes. The next deploy replaces the sandbox host (rolling update), so running sandboxes on it stop.
