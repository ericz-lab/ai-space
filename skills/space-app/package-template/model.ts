// Ask the Space's model service (docs/model.md in ai-space). No model is named: the Space picks one
// for this app and `tag`, so the operator can change it from the panel without touching the app.
export async function ask(prompt: string, opts: { tag?: string; system?: string; timeoutMs?: number } = {}): Promise<string> {
  const base = process.env.SPACE_API_URL;
  const token = process.env.SPACE_APP_TOKEN;
  if (!base || !token) throw new Error("SPACE_API_URL and SPACE_APP_TOKEN are missing: run the app inside ai-space");
  const res = await fetch(new URL("/api/model/run", base), {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ prompt, ...opts }),
    // Bun's fetch drops a connection idle for 5 minutes; a model call sends nothing until it answers.
    timeout: false,
  });
  const data = (await res.json()) as { ok: boolean; text?: string; error?: string };
  if (!data.ok || typeof data.text !== "string") throw new Error(data.error ?? `model call failed (${res.status})`);
  return data.text;
}
