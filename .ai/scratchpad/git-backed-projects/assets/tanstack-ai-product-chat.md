# TanStack AI for product chat

Research date: 2026-08-13

## Executive summary

- TanStack AI has official packages for both sides of this application: `@tanstack/ai-react` supplies a React `useChat` hook for the Vite/TanStack Start frontend, while `@tanstack/ai` supplies server-side `chat()`, tool execution, and standard `Response` helpers for SSE or NDJSON. Its own docs explicitly describe the extra error handling needed in Hono. In that framework-and-transport sense, it can power both ends.
- It is not a drop-in replacement for the current end-to-end path. The frontend message/part and loading-state APIs differ from Vercel AI SDK, and the backend currently runs a multi-node LangGraph retrieval DAG, not only an LLM tool loop.
- The published core package declares Node `>=18`, not Bun, as its engine contract. A local smoke test on Bun 1.3.14 successfully imported the researched packages and produced an SSE `Response`; no live provider request or full application run was tested. This is positive runtime evidence, not an official Bun support guarantee.
- TanStack AI can persist transcripts, run status, and interrupts through `@tanstack/ai-persistence`, but the application must implement the stores against its own database. There is no published `@tanstack/ai-persistence-postgres` package. This persistence is not equivalent to LangGraph's per-super-step graph checkpoints.
- Resumable delivery is a separate feature from conversation persistence. Production resume needs an external durability service through `@tanstack/ai-durable-stream` or an application-owned `StreamDurability` implementation; the built-in in-memory log is single-process development storage.

## Findings with citations

### 1. What the repository does today

The browser and server are coupled through the Vercel AI SDK protocol:

- `apps/ui/src/features/chat/ChatWorkspace.tsx` imports `useChat` from `@ai-sdk/react`, supplies initial messages from the conversation `GET`, handles a custom `data-rename-conversation` part, and exposes Vercel's `submitted | streaming | ready | error` state to the UI.
- `apps/ui/src/features/chat/chatTransport.ts` creates an AI SDK `DefaultChatTransport` for `/:orgSlug/api/v1/conversations/:conversationId`, sends cookies, and sends only the newest message plus `source`.
- `apps/backend/src/routes/v1/conversations.ts` creates or verifies the conversation metadata row, then starts the graph stream. Its `GET` loads messages through `loadConversationUiMessages`.
- `apps/backend/src/domain/conversations/transport.ts` invokes `conversationGraph.stream`, converts the LangGraph stream with `@ai-sdk/langchain`'s `toUIMessageStream`, applies local tool/text repair transforms, and emits a Vercel AI SDK UI-message response.
- `apps/backend/src/graphs/conversationGraph/graph.ts` compiles a nine-node `StateGraph` with `PostgresSaver`, keyed by `thread_id = conversationId` and an empty checkpoint namespace. `apps/backend/src/graphs/conversationGraph/state.ts` includes messages plus query, embedding, retrieval plan/results, tenant identifiers, candidates, and assembled retrieval context.
- `apps/backend/src/graphs/conversationGraph/nodes/extractQuery.ts` obtains `orgId` and `orgSlug` from trusted backend request context. The retrieval nodes use those values for scoped searches.
- `apps/backend/src/db/schema/conversations.ts` stores conversation metadata scoped by `orgId` and `userId`, but it stores neither messages nor a `projectId`. `apps/backend/src/models/conversations.ts` applies both org and user filters. Thus today's chat is org-and-user scoped, not project scoped at the conversation-schema level.

The installed path is currently `@ai-sdk/react` `^3.0.107`, `ai` `^6.0.105`, `@ai-sdk/langchain` `^3.0.11`, `@langchain/langgraph` `^1.4.7`, and `@langchain/langgraph-checkpoint-postgres` `^1.0.4` in `apps/ui/package.json` and `apps/backend/package.json`.

### 2. Official packages and versions

Published versions observed from the npm registry on the research date:

| Role | Package | Version | Relevant official surface |
| --- | --- | ---: | --- |
| Backend core | [`@tanstack/ai`](https://www.npmjs.com/package/@tanstack/ai) | `0.44.0` | `chat()`, tools, middleware, AG-UI request parsing, SSE/NDJSON responses |
| Headless browser client | [`@tanstack/ai-client`](https://www.npmjs.com/package/@tanstack/ai-client) | `0.23.2` | `ChatClient`, HTTP connection adapters, UI message state |
| React frontend | [`@tanstack/ai-react`](https://www.npmjs.com/package/@tanstack/ai-react) | `0.19.2` | React `useChat`; re-exports connection adapters |
| Chat persistence | [`@tanstack/ai-persistence`](https://www.npmjs.com/package/@tanstack/ai-persistence) | `0.1.3` | `withPersistence`, store definitions, conformance test kit |
| External stream durability | [`@tanstack/ai-durable-stream`](https://www.npmjs.com/package/@tanstack/ai-durable-stream) | `0.1.1` | Adapter for an external Durable Streams backend |
| OpenAI adapter example | [`@tanstack/ai-openai`](https://www.npmjs.com/package/@tanstack/ai-openai) | `0.19.0` | OpenAI and OpenAI-compatible text adapters |
| OpenRouter adapter relevant to the current provider matrix | [`@tanstack/ai-openrouter`](https://www.npmjs.com/package/@tanstack/ai-openrouter) | `0.16.1` | OpenRouter text adapters |
| Bedrock adapter relevant to the current provider matrix | [`@tanstack/ai-bedrock`](https://www.npmjs.com/package/@tanstack/ai-bedrock) | `0.2.1` | Bedrock Converse/chat/responses adapters |

The packages are independently versioned and all are pre-1.0. Their current package manifests are in the official repository: [`packages/ai/package.json`](https://github.com/TanStack/ai/blob/main/packages/ai/package.json), [`packages/ai-client/package.json`](https://github.com/TanStack/ai/blob/main/packages/ai-client/package.json), [`packages/ai-react/package.json`](https://github.com/TanStack/ai/blob/main/packages/ai-react/package.json), and [`packages/ai-persistence/package.json`](https://github.com/TanStack/ai/blob/main/packages/ai-persistence/package.json).

The current backend supports `openai-like`, `openrouter`, `azure`, and `bedrock` through LangChain-backed factories in `apps/backend/src/retrieval/services/modelProvider.ts`. TanStack publishes dedicated OpenRouter and Bedrock adapters and documents an OpenAI-compatible adapter, including Azure configuration, but preserving this repository's exact model fallback, parameter-normalisation, and observability behavior would be separate adapter integration work. See the official [OpenAI-compatible](https://tanstack.com/ai/latest/docs/adapters/openai-compatible), [OpenRouter](https://tanstack.com/ai/latest/docs/adapters/openrouter), and [Bedrock](https://tanstack.com/ai/latest/docs/adapters/bedrock) docs.

### 3. Frontend fit

The official [`@tanstack/ai-react` API](https://tanstack.com/ai/latest/docs/api/ai-react) exposes `useChat({ connection, threadId, initialMessages, tools, ... })` and returns `messages`, `sendMessage(string)`, `isLoading`, `error`, `stop`, and `setMessages`. `fetchServerSentEvents(url, options)` supports headers and `credentials`, so the current same-origin cookie request can be represented. The official [React quick start](https://tanstack.com/ai/latest/docs/getting-started/quick-start) uses TanStack Start and Vite-compatible React code.

The migration surface is nevertheless observable in the public types:

- TanStack text and thinking parts use `content`; the current `ConversationThread.tsx` reads Vercel parts such as `{ type: "text", text }`, `{ type: "reasoning", text }`, `source-url`, and `data-*`.
- TanStack exposes `isLoading` rather than Vercel's four-value `ChatStatus`; `ChatWorkspace.tsx`, `ConversationThread.tsx`, and `MessageInputBox.tsx` currently branch on `submitted` versus `streaming`.
- TanStack `sendMessage` accepts a string, whereas the current components pass `{ text }`.
- TanStack tool call/result parts and approval states are first-class. The current renderer intentionally does not render tool parts.
- TanStack custom `CUSTOM` stream events can be observed through `onChunk`; that can carry an event serving the same UI purpose as today's rename event, but today's `data-rename-conversation` wire part is not the same protocol. See the official [streaming event reference](https://tanstack.com/ai/latest/docs/chat/streaming) and [custom event reference](https://tanstack.com/ai/latest/docs/protocol/custom-events).

### 4. Backend, Hono, and Bun

The core [`chat()` API](https://tanstack.com/ai/latest/docs/api/ai) takes messages, a provider adapter, tools, runtime context, middleware, and run/thread IDs, and returns an `AsyncIterable` of AG-UI stream chunks. `toServerSentEventsResponse()` converts it to a standard web `Response` with SSE headers; `toHttpResponse()` is the corresponding NDJSON path.

There is no Hono-specific TanStack AI package required. The official request parser documentation explicitly names Hono: Hono does not automatically turn a thrown `Response` from `chatParamsFromRequest()` into the route response, so a Hono handler must catch it or call `chatParamsFromRequestBody(await c.req.json())` and handle validation itself. The resulting standard `Response` can be returned by the Hono route. See [`chatParamsFromRequest`](https://tanstack.com/ai/latest/docs/reference/functions/chatParamsFromRequest) and [`chatParamsFromRequestBody`](https://tanstack.com/ai/latest/docs/reference/functions/chatParamsFromRequestBody).

For Bun:

- The official `@tanstack/ai@0.44.0` manifest declares only `"engines": { "node": ">=18" }`; the React/client/persistence manifests do not add an explicit Bun engine declaration.
- TanStack's repository does exercise Bun-specific code elsewhere, but that does not establish a compatibility guarantee for every provider adapter.
- Local evidence: on Bun `1.3.14`, imports of `@tanstack/ai@0.44.0`, `@tanstack/ai-client@0.23.2`, `@tanstack/ai-react@0.19.2`, `@tanstack/ai-openai@0.19.0`, and `@tanstack/ai-persistence@0.1.3` succeeded. A synthetic two-event async iterable passed through `toServerSentEventsResponse()` returned status `200`, `content-type: text/event-stream`, and an SSE body containing `RUN_STARTED`. This did not exercise a network model call, Hono middleware, the repository's graph/search tools, or production deployment.

The supported conclusion is therefore narrower than “official Bun support”: the relevant published ESM packages and Web `Response` streaming helper work in the tested Bun runtime, while the package's declared engine remains Node.

### 5. Streaming and tool calls

TanStack AI's official [tools guide](https://tanstack.com/ai/latest/docs/tools/tools) defines schemas once with `toolDefinition()`, then attaches `.server()` or `.client()` implementations. Server tools run automatically inside `chat()`'s agent loop; client tools and approval responses are handled by the headless/React client. Server tools can receive typed request runtime context and emit custom progress events.

That covers a conventional model → tool(s) → model cycle. It does not itself reproduce the current graph topology in `apps/backend/src/graphs/conversationGraph/graph.ts`: query extraction and conversation naming begin in parallel; extraction then passes through planning, multiple retrieval channels, normalisation, reranking, graph focus, context assembly, and finally a nested ReAct agent. TanStack's `chat()` offers an agent-loop strategy and middleware, but the cited API does not claim to import or execute a LangGraph `StateGraph`. Keeping equivalent orchestration would require application code or retaining a graph boundary.

### 6. Conversation persistence

The official [chat persistence](https://tanstack.com/ai/latest/docs/persistence/chat-persistence) middleware can persist:

- full authoritative model-message history per `threadId`;
- run status (`running`, `interrupted`, `completed`, `failed`, or `aborted`);
- pending interrupts for tool approval, client tools, or generic waits;
- optional throttled snapshots of partial assistant text.

The persistence package supplies interfaces, an in-memory implementation, and a conformance suite—not a Postgres schema for this app. The official [build-your-own-adapter](https://tanstack.com/ai/latest/docs/persistence/build-your-own-adapter) guide says the application maps `MessageStore`, `RunStore`, and optionally `InterruptStore` to its own tables/ORM. A transcript-only implementation needs `messages`; the documented common production shape is `messages + runs + interrupts`.

The authoritative-history contract also differs from the current delta request: a non-empty request is interpreted as the complete transcript and overwrites the stored thread, while an empty message array asks the middleware to load the stored thread. The route/client pair must follow that contract rather than preserving `chatTransport.ts`'s “send only the newest message” body unchanged.

### 7. What stops working if `PostgresSaver` is simply removed

LangGraph's official [persistence documentation](https://docs.langchain.com/oss/javascript/langgraph/persistence) and [checkpointer documentation](https://docs.langchain.com/oss/javascript/langgraph/checkpointers) state that a checkpointer saves graph-state snapshots by thread at every super-step, provides conversation continuity, state history/time travel, human-in-the-loop state, and fault-tolerant restart. Pending writes let successful parallel nodes avoid rerunning when another node in the same super-step fails.

Against this repository, removing the saver without replacing each consumed capability has concrete effects:

| Current dependency on checkpoints | Effect of removal | TanStack AI coverage |
| --- | --- | --- |
| `conversationGraph.stream()` receives only the newest `HumanMessage`; the checkpointer restores the thread's prior message state. | Later turns lose server-side history unless the full transcript is supplied or loaded elsewhere. | `withPersistence` can supply transcript continuity after an app-owned `MessageStore` is implemented. |
| `loadConversationUiMessages()` calls `conversationGraph.getState()` and converts the checkpointed LangChain messages for the conversation `GET`. | Existing and new conversation detail responses return no messages through that code path. | `reconstructChat` can hydrate TanStack messages from a TanStack persistence store; it cannot read LangGraph checkpoint rows automatically. |
| The checkpoint contains the full `ConversationGraphStateSchema`, not only messages. | Query embeddings, plans, retrieval intermediates, tenant fields, assembled context, and other graph state are no longer checkpointed at super-step boundaries. | TanStack chat persistence documents transcripts/runs/interrupts/metadata, not arbitrary LangGraph execution snapshots. |
| LangGraph records checkpoints and pending writes across the retrieval DAG. | Mid-graph crash recovery, state history/time travel, and “do not rerun successful sibling nodes” behavior are lost. | Stream durability replays delivered events; it does not recreate graph-node checkpoint semantics. |
| Existing histories live in LangGraph checkpoint tables. | Switching the read path makes old chats unavailable unless their messages are migrated or a legacy reader remains. | No documented automatic migration or compatibility layer exists. |
| `@ai-sdk/langchain` and local repair transforms translate LangChain messages/tool events into Vercel UI parts. | Source, reasoning, tool, and custom-event rendering changes with the protocol. | TanStack has its own AG-UI parts and custom events; application mapping remains necessary. |
| The `conversationNaming` node emits a LangGraph custom writer event that is rewritten into `data-rename-conversation`. | Optimistic conversation-list renaming no longer receives that event. | A TanStack `CUSTOM` event can carry application progress, but naming execution and the client cache update remain application behavior. |

TanStack persistence can replace the transcript/run/interrupt subset, but it does not preserve LangGraph's arbitrary graph-state checkpoints, pending writes, or execution history.

## Constraints

### Authentication and authorization

TanStack AI does not authenticate a route or authorize a thread. The current endpoint gets cookie/bearer auth and org context from `apps/backend/src/routes/v1/index.ts`, and conversation model functions enforce `orgId + userId`. Those controls remain application responsibilities around either the `POST` or hydration `GET`.

The official [persistence overview](https://tanstack.com/ai/latest/docs/persistence/overview) specifically warns that `reconstructChat` needs an `authorize(threadId, request)` callback or anyone who guesses a thread ID can retrieve its transcript. The same ownership check is needed before starting/continuing a run; a persistence adapter keyed only by `threadId` does not create tenant isolation by itself.

### Multi-tenant org and project scoping

TanStack's [runtime context](https://tanstack.com/ai/latest/docs/advanced/runtime-context) can pass trusted `{ userId, orgId, projectId, db }` values to server tools and middleware. Client runtime context is not serialized. `forwardedProps` is serialized but is explicitly client-controlled and must be validated and mapped to trusted server context.

The current database and routes establish org/user ownership but no project relation: `conversations` has no `projectId`, and the route contains no project path or project membership lookup. TanStack does not fill this domain gap. A stable conversation/thread relation to a project and server-side project authorization are separate application contracts, regardless of chat SDK.

Persistence stores must also scope every thread/run lookup consistently. The minimal TanStack `MessageStore` interface takes only `threadId`, so tenant enforcement has to come from globally unguessable/unique IDs, adapter context/queries, an authorization layer, or a combination owned by the application.

### Resumable streams

TanStack distinguishes saved conversation state from resumable delivery. Per the official [resumable streams guide](https://tanstack.com/ai/latest/docs/resumable-streams/overview):

- `memoryStream(request)` is single-process and intended for development.
- `@tanstack/ai-durable-stream` writes to an external Durable Streams backend.
- A different Postgres/Redis/queue implementation must satisfy the five-method [`StreamDurability` contract](https://tanstack.com/ai/latest/docs/resumable-streams/custom-adapter).
- Reconnect can replay without re-running the model, but surrounding route side effects must be idempotent because a reconnect can repeat the request.
- The ordinary replay `GET` does not keep computation alive if the producer process dies; the log stops growing when its producer dies.

Consequently, conversation persistence alone does not make a live answer resumable, and resumable delivery alone does not make the underlying agent execution durable.

### Attaching a separate OpenCode runtime

No OpenCode or Docker behavior was researched here. From TanStack AI's documented generic surface only:

- A server tool can call arbitrary application code and emit custom events, so a separate runtime can be represented at the chat protocol boundary as a tool/integration.
- TanStack's standard chat persistence stores a transcript, runs, and interrupts; its stream durability stores emitted chunks. Neither fact establishes how an external runtime's session, filesystem, process, cancellation, authorization, or recovery model maps into those records.
- The resumable-stream docs explicitly distinguish replaying a log from keeping or taking over the producer. Therefore attaching the UI stream does not, by itself, prove that a separate runtime continues after backend process death or can be resumed safely.

The external runtime boundary, lifecycle, and durable identity remain unspecified by this research.

### API maturity and migration compatibility

All researched TanStack packages are independently versioned `0.x` releases. The current Vercel UI-message protocol, LangChain message types, LangGraph checkpoint schema, and TanStack AG-UI/persistence records are different contracts. No official compatibility layer was found that would let this repository swap package imports while retaining existing wire messages and checkpoint rows unchanged.

## What this does NOT decide

- Whether the product should adopt TanStack AI, keep Vercel AI SDK, keep LangGraph, or use a hybrid boundary.
- Whether the retrieval DAG should be preserved, rewritten as ordinary application code, or reduced to tools/middleware.
- The Postgres schema, retention policy, migration strategy, or tenant key design for TanStack persistence and stream logs.
- Which provider adapters should replace the current model-provider matrix or how model fallback and Langfuse instrumentation should behave.
- Whether product chat should use SSE or NDJSON.
- The design, deployment, security, or lifecycle of a separate OpenCode runtime or Docker environment.
- Whether project chat is private per user, shared within a project, or visible at another collaboration scope.
