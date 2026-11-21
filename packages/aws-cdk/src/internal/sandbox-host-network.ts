/**
 * The network of the sandbox host: the Docker daemon settings and the
 * firewall that keep sandboxes apart. The construct writes them into the boot
 * script. The backend's contract test `sandbox-host-network.contract.test.ts`
 * runs the same values in Docker-in-Docker. That test is in the backend,
 * because only the backend's contracts lane runs Docker.
 *
 * Sandboxes are on `docker0`. Agent Vault is on its own bridge
 * (`AGENT_VAULT_NETWORK`). A sandbox dials Agent Vault's proxy on a host
 * address, and Docker forwards it to the bridge of Agent Vault.
 */

/** Agent Vault's API (backend and worker) and proxy (sandboxes only). */
export const AGENT_VAULT_API_PORT = 14321
export const AGENT_VAULT_PROXY_PORT = 14322
/** The bridge of Agent Vault. Its Linux name is the same. */
export const AGENT_VAULT_NETWORK = "ctxpipe-av"

/**
 * The daemon.json keys that shape the sandbox network.
 *
 * - `icc: false`: agent ports are published for the backend, so anything
 *   that reaches the host could reach them. Sandboxes must not reach each
 *   other over the bridge.
 * - `userland-proxy: false`: Docker forwards each published port with DNAT
 *   only, and starts no docker-proxy. docker-proxy ends each connection on
 *   the host. Agent Vault then saw one address for all sandboxes of all
 *   organizations. Its pre-auth gate (50 proxy-auth failures in 5 minutes
 *   for each peer address) let one sandbox lock every sandbox out
 *   (CTX-1472).
 * - `ip-masq: false`: no source NAT for `docker0`, so the sandbox address
 *   stays on the way to Agent Vault's bridge. (With docker-proxy on, Docker
 *   also skips the DNAT for traffic from a bridge that has NAT, and sends it
 *   to docker-proxy.) Sandboxes reach nothing else, so they need no NAT.
 *   Agent Vault's own bridge keeps its NAT to the internet.
 *
 * With both, Agent Vault sees the address of each sandbox.
 *
 * Known gap: Docker gives the address of a removed container to the next
 * container at once. A sandbox that fails the gate and then ends can lock
 * out the next sandbox that gets its address, for up to 5 minutes. That
 * sandbox can be of another organization. A gate key of the address and the
 * run's vault name in Agent Vault closes this gap (the production part of
 * CTX-1472).
 */
export const SANDBOX_HOST_NETWORK_DAEMON_CONFIG = {
  icc: false,
  "userland-proxy": false,
  "ip-masq": false,
} as const

/**
 * One rule: check it with `-C`, and insert it with `-I` (at the top of its
 * chain) only when it is missing.
 */
function rule(table: "filter" | "raw", chain: string, spec: string) {
  const tableFlag = table === "filter" ? "" : `-t ${table} `
  return `iptables ${tableFlag}-C ${chain} ${spec} 2>/dev/null || iptables ${tableFlag}-I ${chain} ${spec}`
}

/**
 * The firewall commands, in order. The host runs all of them after each start
 * of dockerd. Each one is idempotent. A rule inserted later goes above the
 * rules before it in its chain, so it is checked first.
 */
export const SANDBOX_HOST_FIREWALL = [
  // Docker 25 puts its isolation jump above DOCKER-USER when dockerd
  // restarts, and that jump drops the sandbox traffic to Agent Vault's
  // bridge. Put DOCKER-USER first again. A second jump is safe: each rule in
  // DOCKER-USER gives the same verdict on the second pass.
  `iptables -S FORWARD 1 | grep -qx -- "-A FORWARD -j DOCKER-USER" || iptables -I FORWARD 1 -j DOCKER-USER`,
  // Sandboxes never reach the host itself (other sandboxes' published agent
  // ports, the Docker API) or instance metadata (next to the IMDS hop limit).
  // Fails closed.
  rule("filter", "INPUT", "-i docker0 -j REJECT"),
  rule("filter", "DOCKER-USER", "-d 169.254.169.254/32 -j REJECT"),
  // Sandboxes (docker0) reach only Agent Vault's proxy, published on the host
  // and forwarded to its own bridge: no direct internet, backend, VPC, or
  // DNS. A published port of another sandbox is forwarded to docker0, so this
  // reject refuses it too.
  rule("filter", "DOCKER-USER", "-i docker0 -j REJECT"),
  rule(
    "filter",
    "DOCKER-USER",
    "-i docker0 -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN",
  ),
  // ACCEPT, not RETURN: Docker's isolation rules drop traffic between two
  // bridges. This rule sits above the reply rule above, because Docker 25
  // drops the later packets of the connection too.
  rule(
    "filter",
    "DOCKER-USER",
    `-i docker0 -o ${AGENT_VAULT_NETWORK} -p tcp --dport ${AGENT_VAULT_PROXY_PORT} -j ACCEPT`,
  ),
  rule(
    "filter",
    "DOCKER-USER",
    `-i ${AGENT_VAULT_NETWORK} -o docker0 -p tcp --sport ${AGENT_VAULT_PROXY_PORT} -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT`,
  ),
  // Docker 28 drops a packet to a container address that comes from another
  // bridge (raw PREROUTING), and the proxy's replies to sandboxes are such
  // packets. This accept skips only that drop: the filter rules above still
  // pass only replies of connections that a sandbox opened.
  rule(
    "raw",
    "PREROUTING",
    `-i ${AGENT_VAULT_NETWORK} -p tcp --sport ${AGENT_VAULT_PROXY_PORT} -j ACCEPT`,
  ),
  // Agent Vault never reaches the host (its own management API on the host's
  // address, the Docker API), itself back through a published port, or a
  // sandbox. INPUT refuses only new connections: replies to the host's own
  // /health check must pass. Without docker-proxy, a connection from Agent
  // Vault to a sandbox's published port on the host address is forwarded to
  // docker0, so DOCKER-USER refuses new connections there too.
  rule(
    "filter",
    "INPUT",
    `-i ${AGENT_VAULT_NETWORK} -m conntrack ! --ctstate ESTABLISHED,RELATED -j REJECT`,
  ),
  rule(
    "filter",
    "DOCKER-USER",
    `-i ${AGENT_VAULT_NETWORK} -o docker0 -m conntrack ! --ctstate ESTABLISHED,RELATED -j REJECT`,
  ),
  rule(
    "filter",
    "DOCKER-USER",
    `-i ${AGENT_VAULT_NETWORK} -o ${AGENT_VAULT_NETWORK} -j REJECT`,
  ),
]

/** Creates Agent Vault's bridge when it is missing. */
export const AGENT_VAULT_NETWORK_CREATE = `docker network inspect ${AGENT_VAULT_NETWORK} >/dev/null 2>&1 || docker network create -o com.docker.network.bridge.name=${AGENT_VAULT_NETWORK} ${AGENT_VAULT_NETWORK}`
