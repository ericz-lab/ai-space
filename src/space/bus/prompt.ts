import type { AppCapabilities } from "./bus.ts";

/**
 * The catalogue as a system-prompt section for agents: what other apps provide
 * (and how to call it), what they publish, and how to publish. Kept short: one
 * line per capability or event, descriptions only, no examples, capped in size.
 */

const MAX_CHARS = 6_000;

export type CapabilitiesPromptOptions = {
  /** The agent's own app: listed last and marked, so it knows what it offers. */
  self?: string;
  /** The space agent calls as the operator with SPACE_API_TOKEN; an app agent with its SPACE_APP_TOKEN. */
  operator?: boolean;
};

export function capabilitiesPrompt(apps: (AppCapabilities & { peer?: string })[], opts: CapabilitiesPromptOptions = {}): string | undefined {
  const listed = apps.filter((a) => a.provides.length || a.publishes.length);
  if (!listed.length) return undefined;
  const token = opts.operator ? "$SPACE_API_TOKEN" : "$SPACE_APP_TOKEN";
  const head = [
    "--- Space capabilities ---",
    "Apps on this space offer these through ai-space (docs/events.md); every app is reached the same way, whichever machine it runs on.",
    `Call a capability: curl -sS -X POST "$SPACE_API_URL/api/call/<app>/<capability>" -H "Authorization: Bearer ${token}" -H "content-type: application/json" -d '<json>'`,
    `Publish an event: curl -sS -X POST "$SPACE_API_URL/api/events" -H "Authorization: Bearer ${token}" -H "content-type: application/json" -d '{"name":"<event>","data":{}}'`,
    "Full catalogue with examples: GET $SPACE_API_URL/api/capabilities",
    "",
  ];
  const sorted = [...listed].sort((a, b) => (a.app === opts.self ? 1 : b.app === opts.self ? -1 : a.app.localeCompare(b.app)));
  const blocks: string[] = [];
  for (const a of sorted) {
    const lines = [`${a.app}${a.peer ? ` (on peer ${a.peer})` : ""}${a.app === opts.self ? " (this app)" : ""}`];
    for (const c of a.provides) lines.push(`  provides ${c.name}${c.description ? ` — ${c.description}` : ""} (${c.method}${c.callers ? `, callers: ${c.callers.join(", ")}` : ""})`);
    for (const p of a.publishes) lines.push(`  publishes ${a.app.includes("/") ? a.app.slice(a.app.indexOf("/") + 1) : a.app}/${p.name}${p.description ? ` — ${p.description}` : ""}`);
    blocks.push(lines.join("\n"));
  }
  let out = head.join("\n") + blocks.join("\n");
  if (out.length > MAX_CHARS) out = `${out.slice(0, MAX_CHARS - 40)}\n  … (more in GET /api/capabilities)`;
  return out;
}
