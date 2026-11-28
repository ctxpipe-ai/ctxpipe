# The agent workspace of an answer-only task. The B1+ arm mounts the corpus
# at /app/org; the CTX arm gets this empty workspace and the ctxpipe MCP.
FROM python:3.12-slim-bookworm

RUN apt-get update \
  && apt-get install -y --no-install-recommends bash ca-certificates curl git procps ripgrep \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
