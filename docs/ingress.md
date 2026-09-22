# Ingress: how the outside reaches a space

Status: decided and in use. Every machine publishes its panel and its apps through a Cloudflare Tunnel (option A below); nothing listens on a public port. This document records the alternatives that were weighed and why they lost, so the choice is not reopened by accident. The install steps are in [install.md](install.md) (steps 5 and 6).

## Problem

A space binds loopback on purpose: the panel on `127.0.0.1:8700`, every app service on `127.0.0.1:<port>`. Something has to carry a request from a browser on the internet to those ports, terminate TLS, and put a login in front, because the panel routes carry no token of their own ([panel.md](panel.md#trust-boundary)): whoever reaches the panel can open a chat with write permissions, and the terminal is a shell. The same something has to work on every machine a space runs on, including a box behind NAT with no public address and no sudo.

## Options

**A. Cloudflare Tunnel.** `cloudflared` runs as a user unit and keeps an outbound connection to Cloudflare's edge. The edge terminates TLS, applies Access, and pushes requests down the connection to loopback. No inbound port, no public address needed.

**B. Port 443 behind Cloudflare's proxy.** A web server (Caddy, nginx) on the machine binds 443 with a certificate for the origin; DNS is proxied ("orange cloud"), so the edge still terminates TLS, applies Access and forwards to the origin over HTTPS. The firewall admits Cloudflare's address ranges only.

**C. Port 443, direct.** The same web server on 443, DNS unproxied. The browser talks to the machine; the machine holds a public certificate (Caddy obtains one from Let's Encrypt) and does its own authentication.

## Comparison

| | A. Tunnel | B. 443 + proxy | C. 443 direct |
| --- | --- | --- | --- |
| Open inbound ports | none | 443, filtered to Cloudflare's ranges | 443 to everyone |
| Origin address | hidden | hidden while the filter is right | public |
| TLS termination | edge; the machine speaks plain HTTP on loopback | edge and origin (origin certificate or Let's Encrypt) | origin only |
| Login in front (Access) | yes | yes | no; the machine authenticates by itself |
| DDoS, WAF, edge cache | yes | yes | no |
| Needs root | no: a user unit and one token | yes: binding 443, the firewall | yes: binding 443, the firewall |
| Path | browser, edge, tunnel, loopback | browser, edge, origin | browser, origin |
| Latency | one encapsulation more than B, a few ms | edge to origin over TCP | shortest, but no edge near a distant user |
| Upload size | 100 MB per request on the free plan (an edge limit) | same | unlimited |
| WebSocket, SSE | yes | yes | yes |
| Dependence on Cloudflare | total | total | none |
| A machine behind NAT | works | needs a public address | needs a public address |
| Operations | one unit, one token | certificate, firewall ranges kept current, root | certificate (automatic), firewall |

## Decision: A

The tunnel is the choice, for these reasons in order:

1. **The login is the security model.** The panel and the terminal rely on an access layer in front of them. Access comes with A and B; with C it has to be rebuilt in Caddy or in every app.
2. **No sudo.** Everything a space owns is a user unit in one home directory ([install.md](install.md)); A is the only option that keeps ingress there too. B and C need root for the port and the firewall, and B needs a list of address ranges kept current.
3. **Every machine, the same way.** A peer with no public address ([peers.md](peers.md)) publishes exactly like the hub. B and C cannot.
4. **Nothing to scan.** With A the machine has no open port; a misconfigured firewall cannot expose anything, because there is nothing to expose.

What A costs, and why it is accepted:

- **Cloudflare is a dependency.** If the edge is down, every space is unreachable. Accepted: it is also the login, the DNS and the backups' bucket already; ingress does not add a new dependency, and the operator can still reach the machine over SSH.
- **100 MB per request.** Accepted: no route in the space takes uploads of that size; an app that needs one hands the browser a presigned URL to the blob store and the file never passes the edge.
- **One extra hop.** A few milliseconds between the edge and loopback. Not measurable next to a model call.

## When to revisit

- An app must accept uploads larger than the edge allows and cannot use presigned direct uploads.
- A public, unauthenticated service where every millisecond counts is added; C for that one hostname would be the answer, next to A for everything else, not instead of it.
- Cloudflare stops offering the tunnel, Access or proxied wildcard records on the plan in use.

None of these changes the decision for the panel and the agents' routes, which stay behind A.

## What this does not decide

- **One hostname per app, or a wildcard.** Whether each app gets its own tunnel rule or one wildcard rule sends everything to a router on the machine is the next decision and is orthogonal to this one; both run over the tunnel.
- **How the peer's apps are named** (their own domain, a subdomain, explicit records). Also orthogonal: each machine has its own tunnel whatever the names are.
