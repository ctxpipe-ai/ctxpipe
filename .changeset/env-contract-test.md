---
"@ctxpipe/aws-cdk": patch
---

Add the rule for model settings that can serve the knowledge plane (`knowledge-plane-settings.ts`, not exported yet), and an env contract test. The test checks that each ECS task of the construct, and each service of the Compose `deploy` profile, passes the backend start check and the plane rule, and gets the settings that it needs.
