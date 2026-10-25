FROM node@sha256:63538dfe497cc29dfafdda25ada09b46db68a3f4cc205abf1f5d6bf0913f3384

# Build-time tools only; a conversation never installs its harness as root.
# The ingest skills run ast-grep and ripgrep in this image (ADR-052).
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates git gh findutils ripgrep \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global opencode-ai@1.18.34 undici@7.30.0 @ast-grep/cli@0.45.0 \
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
