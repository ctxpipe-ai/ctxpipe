---
"@ctxpipe/aws-cdk": patch
---

improvement: When `MODEL_HIGH_NAME` is unset, the high tier uses GPT-6 Luna with xhigh reasoning (`openai/gpt-6-luna?reasoning.effort=xhigh`), not Xiaomi MiMo-V2.6-Pro.

With this default, all three tiers use the same base model, so the default OpenRouter fallback chain has no model from another vendor.
