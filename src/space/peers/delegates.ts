import type { MachineAccess, RemoteMachines } from "../agents/delegations-remote.ts";
import type { ConnectionPeerState } from "./connection-peers.ts";
import type { PeerHub } from "./hub.ts";

/**
 * The peers as delegation sees them (docs/orders.md#on-another-machine): which machines this Space may
 * run agents on, and the requests to their `/api/peer/agents/…` routes, through the hub-side peer client
 * in process (HTTPS with the hub token, or a `peer` operation on a package connection).
 *
 * A machine is usable when this Space lists it as a peer (`SPACE_PEER_<NAME>`, or a connection whose
 * other Space grants this one `panel`) and, for a connection peer, that Space also grants `agents` (or
 * full trust); a legacy peer's token reaches the agent routes already. A peer whose last two snapshots
 * failed is offline. Each refusal says what is missing, on which machine.
 */
export function peerMachines(hub: PeerHub, connections: () => ConnectionPeerState[] = () => []): RemoteMachines {
  return {
    access: (machine) => machineAccess(hub, connections(), machine),
    hasAgent: (machine, agent) => !!hub.get(machine)?.snapshot?.agents.some((a) => `${a.app}/${a.name}` === agent),
    request: (machine, path, init = {}) => {
      const c = hub.get(machine);
      if (!c) return Promise.reject(new Error(`no peer ${machine}`));
      return c.request(path, init);
    },
  };
}

export function machineAccess(hub: PeerHub, states: ConnectionPeerState[], machine: string): MachineAccess {
  const client = hub.get(machine);
  if (!client) {
    const st = states.find((s) => s.name === machine);
    const why = st?.state === "no-panel"
      ? `there is a package connection to ${machine}, but ${machine} grants this Space no panel scope on it; on ${machine}: space connection scopes <its connection to this Space> --scopes panel,agents`
      : st && st.state !== "peer"
        ? `a package connection to ${machine} exists but is not a peer here: ${st.reason ?? st.state}`
        : `this Space does not list ${machine} as a peer. On this Space add one: a package connection with ${machine} on which ${machine} grants this Space the panel and agents scopes (docs/peers.md#adding-a-peer), or SPACE_PEER_${machine.toUpperCase().replace(/[^A-Z0-9]/g, "_")} with ${machine}'s SPACE_HUB_TOKEN`;
    return { ok: false, reason: "unlisted", error: why };
  }
  if (client.config.connection) {
    const grant = states.find((s) => s.connection === client.config.connection)?.granted;
    if (!grant || (!grant.fullTrust && !grant.scopes.includes("agents"))) {
      return { ok: false, reason: "no-agents", error: `${machine} is a peer over a package connection that does not grant this Space the agents scope; on ${machine}: space connection scopes <its connection to this Space> --scopes ${[...new Set([...(grant?.scopes ?? ["panel"]), "agents"])].join(",")} (or --full-trust on)` };
    }
  }
  if (client.knownDown()) {
    const s = client.status();
    return { ok: false, reason: "offline", error: `${machine} does not answer${s.asOf ? ` (last snapshot ${s.asOf})` : ""}${s.error ? `: ${s.error}` : ""}` };
  }
  return { ok: true };
}
