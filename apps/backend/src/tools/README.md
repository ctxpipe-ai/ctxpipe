# Backend Agent Tools

This folder contains only agent-callable tools.

- Put non-tool helpers in another folder (for example `src/lib`).
- Keep tool inputs/outputs strongly typed with Zod + TypeScript.
- Tool payloads returned to the LLM should be serialized with TOON.
