---
"@ctxpipe/aws-cdk": patch
---

Tell users when a Workspace needs the format upgrade. The Workspace page and chat show a banner with the next step. Sources and the connect flows say that the upgrade comes first, and they offer no Add until it is merged. A failed upgrade toast shows its cause and offers Ask the agent or Open Upgrades, not a blind retry. Always update answers at once: the server saves the setting and then starts the upgrade, and a file job whose run ended with an error now reports `failed` with its cause.
