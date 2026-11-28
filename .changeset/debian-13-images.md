---
"@ctxpipe/aws-cdk": patch
---

fix: The codesearch runtime and the chat sandbox image now use Debian 13 (Trixie). Debian 12 has critical CVEs that it does not fix. The chat sandbox uses the slim Node image, which is about half the size. Codesearch keeps JDK 17, now from the Temurin image, and Maven 3.9.

The AWS sandbox host now runs Agent Vault 0.40.2 at a fixed digest, not `latest`. A new pin replaces the sandbox host on the next deploy, and the new host starts an empty Agent Vault.
