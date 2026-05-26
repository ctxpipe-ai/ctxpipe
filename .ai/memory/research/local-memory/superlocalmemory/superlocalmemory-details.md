# SuperLocalMemory Details

Sources: https://www.superlocalmemory.com/, https://superlocalmemory.com/, https://arxiv.org/abs/2603.02240, https://arxiv.org/abs/2604.04514, https://www.reddit.com/r/ClaudeAI/comments/1qyo674/superlocalmemory_v2_give_claude_persistent_memory/

## Snapshot

SuperLocalMemory is a local-first agent memory system from Qualixar Research. It emphasizes privacy, no cloud dependency, information-geometric retrieval, memory-poisoning defenses, multi-agent support, and MCP compatibility.

Status: public/open-source positioning. The site says local-first, open source, AGPL v3 / MIT across ecosystem components. Verify exact repo/package license boundaries before embedding.

## How It Works

SuperLocalMemory exposes memory through CLI and MCP integrations. V3 materials describe a memory engine with multi-channel retrieval, biologically inspired forgetting, cognitive quantization, adaptive learning-to-rank, and no LLM inference calls for memory operations.

Public ecosystem components include:

- SLM core memory;
- SLM MCP Hub: federated MCP gateway that learns;
- SLM Mesh: peer-to-peer agent communication and shared state over SQLite plus Unix domain sockets;
- Agent Amplifier: Claude Code hooks for effort routing, goal anchoring, convergence detection, persona escalation, and token budgeting.

## Storage And Data Model

The site and papers emphasize local storage, SQLite, trust scoring, graph/pattern layers, and multi-channel retrieval. The V2/V3 materials describe a layered architecture and memory-poisoning defenses. Exact on-disk schema and import/export should be audited in source.

## Integrations

Public site names Claude Code, Cursor, VS Code Copilot, Windsurf, ChatGPT Desktop, Perplexity, Continue.dev, Zed, and other MCP-compatible clients.

## Selling Points

- Strong privacy/local-first posture.
- Explicit security framing around memory poisoning.
- Broad MCP/client integration story.
- Multi-agent communication/state via SLM Mesh.
- Retrieval claims are more mathematically framed than most competitors.

## Open/Closed Source And Target Users

Open-source: yes according to site, with AGPL v3 / MIT depending on component.

Target users: privacy-sensitive developers, researchers, and teams experimenting with multi-agent local workflows. AGPL components require legal review for commercial embedding.

## Risks And Unknowns

- The marketing/scientific claims are ambitious; implementation and benchmarks need independent verification.
- More components mean larger operational/security review scope.
- AGPL licensing may constrain product integration.
- Coding-project workflow semantics such as tasks/branches may not be the central model.

