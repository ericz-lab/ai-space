import type { AppBusSpec } from "./bus.ts";
import type { Capability, EventPublication } from "./types.ts";

/**
 * ai-space's own entry in the bus catalogue, under the reserved app name `space`
 * (docs/events.md#events-of-ai-space-itself): the events the platform publishes, and the
 * capabilities it answers in process. `Bus.syncBuiltin` registers it at boot, so it is listed in
 * `GET /api/capabilities`, matched by `consumes`, in a peer's snapshot, and mirrored by a hub.
 */

export const SPACE_PUBLISHES: EventPublication[] = [
  { name: "peer.renamed", description: "The operator renamed a peer of this hub: { from, to, id }." },
  { name: "order.issued", description: "An order was stored: { id, text (at most 600 characters), via, image?: { mime, bytes }, createdAt, url }; never the picture." },
  { name: "order.sorted", description: "An order has its topic: { id, topic: { id, title, new }, by: model | fallback | person }." },
  { name: "order.state", description: "A topic's state changed: { topic: { id, title }, state: working | needs-you | done | failed, order?, summary? (at most 600 characters) }." },
  { name: "delegation.started", description: "An agent delegated work to a team member: { id, order?, topic?, from, to, role }; never the brief." },
  { name: "delegation.noted", description: "A message was added to a running delegation, or it was stopped: { id, kind: say | stop, taken? }." },
  { name: "delegation.ended", description: "A delegation ended: { id, state: done | error | stopped | timeout | interrupted, summary (at most 600 characters of the result) }." },
];

/** The built-in capture target: an order for the Director (docs/orders.md#the-capture-target). */
export const ORDER_CAPABILITY: Capability = {
  name: "order",
  description: "Takes an order for the Space's Director: words, or a picture with words. For the panel's clients through /api/capture; called as space.",
  method: "POST",
  path: "/api/capture/order",
  timeoutMs: 30_000,
  capture: { kinds: ["text", "image"], title: "Orders", i18n: { zh: { title: "口谕" } } },
};

export const SPACE_BUS_SPEC: AppBusSpec = { events: { publishes: SPACE_PUBLISHES, consumes: [] }, provides: [ORDER_CAPABILITY] };
