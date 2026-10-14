"use strict"
// With NODE_USE_ENV_PROXY, Node's fetch opens a CONNECT tunnel through the
// proxy for each URL, also for a plain `http://` URL. Agent Vault closes a
// tunnel that carries plain HTTP. This dispatcher sends a plain `http://`
// request to the proxy in absolute form, as curl and Bun do. An `https://`
// request keeps its tunnel. It reads the same proxy variables, NO_PROXY too,
// so no request goes around the proxy. A replaced `NODE_OPTIONS` removes this
// fix but keeps egress closed. Load it with `--import`: Node sets its
// own dispatcher after `--require` preloads.
if (
  process.env.NODE_USE_ENV_PROXY === "1" &&
  (process.env.HTTP_PROXY || process.env.http_proxy)
) {
  const {
    EnvHttpProxyAgent,
    setGlobalDispatcher,
  } = require("/usr/local/lib/node_modules/undici")
  setGlobalDispatcher(new EnvHttpProxyAgent({ proxyTunnel: false }))
}
