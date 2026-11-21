# ADR-070: Each hosted model call goes only to a trusted provider, with ZDR

**Status:** Accepted (the CTO, 2026-11-20) | **Date:** 2026-11-21 | **Tags:** models, openrouter, privacy, zdr, hosted, self-host

## Context

A report of 2026-11-20 says that some providers that advertise ZDR (zero data retention) do not respect it, and that some providers take secrets from prompts. Before this decision, only the calls of the knowledge plane (Jev, the plane embeddings and the vision model) sent a provider block ([ADR-068](ADR-068-knowledge-retrieval-jev-layers.md) decision 7). No call limited the providers. The model tiers, the embeddings of the current stack, the two OpenAI-compatible proxy routes and the eval judges sent no ZDR fields.

The CTO decided ([CTX-1450](https://linear.app/ctxpipe/issue/CTX-1450)):

- "we still trust OpenRouter as such, but we don't trust providers outside of hyper scalers and frontier US labs + typesafe"
- The list: OpenAI, Anthropic, Azure, Amazon Bedrock, Google Vertex, Google AI Studio, TypeSafe. "Keep ZDR policy."
- "This list applies only on hosted version. Selfhosters can put whatever model they want."

## Decision

1. **ADR-068 decision 7 is the rule for each model call of the backend.** Each call that goes to OpenRouter sends one shared provider block (`openRouterProvider()` in `apps/backend/src/retrieval/services/openRouterProvider.ts`):
   - `zdr: true` and `data_collection: "deny"`, as before;
   - `only: [<the allowlist>]`, when the operator sets the allowlist.
   - The block sets no `order` and pins no provider. `allow_fallbacks` keeps its default (`true`), so OpenRouter can fall back among the endpoints that pass all the filters. A call can add its own routing fields (for example `quantizations`, `sort` or `require_parameters`).
2. **The calls.** The block goes on each of these calls:
   - the tier calls (`getModel`), also the provider fields of a model spec (`openrouter.provider.*`), which stay under the block;
   - the embeddings of the current stack (`generateEmbeddings`);
   - the OpenAI-compatible proxy (`/v1/chat/completions` and `/v1/embeddings`) and the model proxy of the workspace chat and ingest sandboxes. The block goes over the provider fields of the client, so a client cannot turn off ZDR or leave the allowlist. A client `only` list stays when each of its providers is on the allowlist, because it then narrows the list. The proxies also drop the client fields that send the content past the provider filters: `plugins` (for example a web search or a file parser at another service), `models` (fallback models) and `route`. A model variant such as `:online` (a web search) is not a configured model, so the OpenAI-compatible proxy refuses it, and the sandbox proxy sets the model itself;
   - Jev, the plane embeddings and the vision model;
   - the eval harness: the judge panel, the latency command (it measures only the endpoints of allowed providers), and the model calls of the MCP eval. The recorder of the knowledge evals no longer adds a provider block to a request: each client sends it.
   - A call goes to OpenRouter when `MODEL_PROVIDER` is `openrouter`, or when the base URL is on the host `openrouter.ai` (also the default URL of `openai-like`). Another OpenAI-compatible API can refuse the unknown `provider` field, so it gets no block. `azure` and `bedrock` call the cloud directly and get no block. The clients of the models that are only on OpenRouter (Jev, the plane embeddings, the vision model) send the block on each call.
   - `src/retrieval/services/openRouterProvider.test.ts` has one case for each client. A new client that bypasses the block must get a case there.
3. **The allowlist is one operator setting, `MODEL_PROVIDER_ALLOWLIST`.** It holds base OpenRouter provider slugs, separated by commas. Unset or empty means no `only` filter. The backend does not start, and each call stops, when:
   - the value is not a list of base slugs: a typing error must not remove the filter;
   - the model settings do not send each call to OpenRouter (`MODEL_PROVIDER` is not `openrouter`, and `MODEL_PROVIDER_URL` is not on `openrouter.ai`). Else a tier call to a gateway in front of OpenRouter would leave the allowlist with no error. Such a gateway sets `MODEL_PROVIDER=openrouter`.

   The hosted stack sets it in the factory (`machines/hosted`). A self-hosted deployment leaves it unset. Docker Compose passes it to the backend when an operator sets it.
4. **The hosted slugs.** From the OpenRouter provider list (`GET https://openrouter.ai/api/v1/providers`, read on 2026-11-21):

   | Provider | Slug | Name in an answer |
   | --- | --- | --- |
   | OpenAI | `openai` | OpenAI |
   | Anthropic | `anthropic` | Anthropic |
   | Azure | `azure` | Azure |
   | Amazon Bedrock | `amazon-bedrock` | Amazon Bedrock |
   | Google Vertex | `google-vertex` | Google |
   | Google AI Studio | `google-ai-studio` | Google AI Studio |
   | TypeSafe | `typesafe` | TypeSafe |
   | Mistral | `mistral` | Mistral |

   The hosted stack file lists each trusted provider on its own line. An active line is in use now. A commented line is trusted, but not used now. When a feature needs that provider, an engineer removes the comment mark: "As a pattern we can say there that any listed option is acceptable, but commented options are not used right now. And also comment out others that are not currently used" (the CTO, 2026-11-21). The same decision adds Mistral (a European lab) as a commented line. The stack file (factory `machines/hosted`, `modelProviderAllowlist`) is the record of the active lines. The provider routing guide (<https://openrouter.ai/docs/features/provider-routing>) says: "When you use a base provider slug (e.g. `"google-vertex"`) in any provider routing field (`order`, `only`, or `ignore`), it matches **all** eligible endpoints for that provider, including any variants or regions." The guide does not say in words that `only`, `zdr` and the fallback combine as an intersection. The probe proves it with real calls (decision 5).
5. **The probe proves the rule.** `factory eval knowledge:probe … -- --setting MODEL_PROVIDER_ALLOWLIST=<hosted value>` adds these checks to the checks of ADR-068 decision 7:
   - each served answer (Jev, the plane embeddings, the vision model, each chat model of the tiers, the fixed model of the commit subjects, the embedding model of the current stack) names a provider of the allowlist. Each chat model goes out alone, with no fallback model, so that a fallback cannot hide a model with no endpoint at an allowed provider;
   - the ZDR pairs of ADR-068 decision 7 send no `only` field, because a control model can be at a trusted provider that the allowlist does not include now;
   - the allowlist pair: the query request of the plane client, sent to a model whose ZDR endpoints are all outside the list, is served with no `only` field and refused with the allowlist. This proves that OpenRouter applies `only` with ZDR and with fallback;
   - `provider-allowlist`: the allowlist is set, and each slug is on the provider list.
   - The factory gives the harness no setting but the key. So the allowlist and each `MODEL_*_NAME` that the hosted stack sets come as `--setting NAME=VALUE` arguments. The probe takes no URL and no key as a setting: the key goes only to the provider that the code names.

## Consequences

- A model with no ZDR endpoint at a provider of the list fails on the hosted stack, and it does not fall back. On 2026-11-21 this applied to two defaults: the plane embedding model (Qwen3 Embedding 8B: Nebius and DeepInfra only) and the old high tier (`xiaomi/mimo-v2.6-pro`: PrimaLabs and DeepInfra only). [CTX-1449](https://linear.app/ctxpipe/issue/CTX-1449) moved the high tier to GPT-6 Luna, and [CTX-1451](https://linear.app/ctxpipe/issue/CTX-1451) moved the plane embeddings to text-embedding-3-large (Azure). The hosted allowlist goes on only after both changes are deployed.
- An operator who adds a model must check that it has a ZDR endpoint at a provider of the list. The probe shows it.
- Self-hosted deployments keep their choice of models and providers. They still get the ZDR fields on each OpenRouter call.
- **Amends** [ADR-068](ADR-068-knowledge-retrieval-jev-layers.md) decision 7: a call sets `provider.only` when the operator sets the allowlist. The other parts of that decision stay.
