# Workspace chat image

Build with `docker build -t ctxpipe-chat-sandbox:local scripts/chat-sandbox`.
The image pins its Node base and OpenCode, includes Git and GitHub CLI, and
runs as UID/GID 1000 with a writable workspace and home. The backend resolves
`SANDBOX_CHAT_IMAGE` to its image ID, so a rebuilt image gets new sandboxes.

Where it comes from:

- Docker Compose (`deploy` profile): the `chat-sandbox-image` service builds
  it inside the `dind` daemon from this checkout.
- AWS CDK: published as `ghcr.io/ctxpipe-ai/chat-sandbox` by `deploy.yaml`;
  the backend pulls it through the sandbox host's daemon on first use.

The image holds no credential, and a sandbox never gets one at runtime. All
sandbox traffic goes through the run's Agent Vault proxy, which adds the GitHub
token and the backend credentials to each request outside the sandbox.

With `NODE_USE_ENV_PROXY`, Node's `fetch` sends each request through a CONNECT
tunnel, also a plain `http://` request. Agent Vault closes a tunnel that
carries plain HTTP. The image loads `node-http-proxy.cjs` through
`NODE_OPTIONS=--import`: that file sends a plain `http://` request to the proxy
in absolute form, as curl and Bun do. OpenCode runs on Bun, so this change is
only for Node processes (for example skill scripts).
