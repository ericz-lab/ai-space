/**
 * The manifest's `speech:` section (docs/speech.md#privacy):
 *
 *   speech:
 *     local-only: true      # never send this app's audio or text to a cloud provider
 */

export type AppSpeechSpec = { localOnly: boolean };

export function parseAppSpeechSpec(raw: unknown): AppSpeechSpec {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("speech must be a mapping, such as { local-only: true }");
  const doc = raw as Record<string, unknown>;
  for (const key of Object.keys(doc)) if (key !== "local-only") throw new Error(`speech has unknown key "${key}"`);
  const localOnly = doc["local-only"];
  if (localOnly !== undefined && typeof localOnly !== "boolean") throw new Error("speech.local-only must be true or false");
  return { localOnly: localOnly === true };
}
