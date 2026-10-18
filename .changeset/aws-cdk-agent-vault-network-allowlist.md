---
"@ctxpipe/aws-cdk": minor
---

Add `sandboxHost.agentVaultNetworkAllowlist`. Agent Vault on the sandbox host can then connect to a private git server, so ingestion can read a plain git repository from it. The stack adds each entry after the backend subnets. Synth rejects an entry that is not an IP address or CIDR, and an entry with a cloud metadata or link-local address.
