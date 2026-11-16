---
---

An ingest model step on an AgentCore sandbox reaches the model. Each AgentCore command now reads stdin from `/dev/null`, as a Docker command does. Before, `opencode run` waited for the end of an open stdin, and each model step stopped at its time limit.
