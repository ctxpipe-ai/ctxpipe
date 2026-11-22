# Debian 13 slim: the full image adds compilers and -dev libraries that no
# chat or ingest step uses, and Debian 12 has unfixed critical CVEs (CTX-1545).
FROM node:26.13.1-trixie-slim@sha256:e6bedef217677b276c591795e169840edd9096dbf13f29df8ef8d1856b8820bc AS base

# Build-time tools only; a conversation never installs its harness as root.
# The ingest skills run ast-grep and ripgrep in this image (ADR-052).
# The backend runs curl in the sandbox: the ingest egress check and the AgentCore
# reads of staged scripts and blobs.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl git gh findutils ripgrep \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global opencode-ai@1.19.5 undici@8.12.4 @ast-grep/cli@0.45.0 \
    && npm cache clean --force \
    && mkdir -p /workspace /home/node/.config /home/node/.local/share /home/node/.local/state /home/node/.cache \
    && chown -R 1000:1000 /workspace /home/node

# No credential helper and no token: the run's Agent Vault proxy adds the
# GitHub credential to each request outside the sandbox.

# Node's fetch tunnels plain `http://` through the proxy, and Agent Vault
# closes such a tunnel. The preload sends those requests in absolute form.
COPY node-http-proxy.cjs /usr/local/lib/ctxpipe/node-http-proxy.cjs
ENV NODE_OPTIONS="--import /usr/local/lib/ctxpipe/node-http-proxy.cjs"
ENV GIT_TERMINAL_PROMPT=0
ENV HOME=/home/node
USER 1000:1000
WORKDIR /workspace
CMD ["sh", "-c", "tail -f /dev/null"]

# AgentCore Runtime (`--target agentcore`): the shim on port 8080 is the
# entry point. The memory snapshot holds the shim only; OpenCode starts later
# as a command (CTX-1219).
FROM base AS agentcore
# PID 1 must reap orphans: a killed command leaves its children to PID 1, and
# Node does not reap them. tini does, and it passes signals to the shim.
USER root
RUN apt-get update \
    && apt-get install -y --no-install-recommends tini \
    && rm -rf /var/lib/apt/lists/*
COPY agentcore-shim.mjs /usr/local/lib/ctxpipe/agentcore-shim.mjs
EXPOSE 8080
# AgentCore runs each command as the image user. Root is that user here,
# because an ingest sandbox needs root (ADR-052); the backend runs each chat
# command as `node`. The shim itself runs as `node`.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["setpriv", "--reuid=1000", "--regid=1000", "--clear-groups", "node", "/usr/local/lib/ctxpipe/agentcore-shim.mjs"]

# The default target: Docker and Compose sandboxes.
FROM base
