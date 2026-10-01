# Workspace chat models and provider lock

Status: accepted (2026-08-22)

Workspace chat (TanStack `opencodeText` + `withSandbox`) must use the same model and provider the app is already configured for. It must not pick a fourth model or a second LLM host.

## Requirements

- **Models:** only `MODEL_FAST_NAME`, `MODEL_MEDIUM_NAME`, or `MODEL_HIGH_NAME` (same names and defaults as LangChain). Chat default tier is **fast**. Do not hardcode Claude Sonnet or any other model.
- **Provider:** OpenCode may send LLM traffic only to the configured `MODEL_PROVIDER` (through the app’s OpenAI-compatible proxy, not Anthropic / OpenAI / OpenRouter / others directly). A request to any other host is a product bug.

## Not this document

Sandbox providers (Cloudflare hosted, Docker self-host) are in [ADR-048](../decisions/ADR-048-native-postgres-sandbox-ownership.md); they do not change the model rule.
