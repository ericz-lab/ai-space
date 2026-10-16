import { realpath } from "node:fs/promises";
import { join, relative, isAbsolute } from "node:path";

/** Resolve skills only inside the selected app, and load their canonical contents for this turn. */
export async function skillContext(appDir: string, names: string[]): Promise<string> {
  if (!names.length || names.length > 4) throw new Error("Expected 1–4 skills");
  const root = await realpath(appDir);
  const parts: string[] = [];
  let bytes = 0;
  for (const name of names) {
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(name)) throw new Error("Invalid skill name");
    const path = await realpath(join(root, "skills", name, "SKILL.md")).catch(() => { throw new Error(`Missing skill: ${name}`); });
    const rel = relative(root, path);
    if (rel === ".." || rel.startsWith("../") || isAbsolute(rel)) throw new Error(`Skill is outside the app: ${name}`);
    const file = Bun.file(path);
    bytes += file.size;
    if (file.size > 65_536 || bytes > 131_072) throw new Error("Skill content exceeds the context limit");
    const content = await file.text();
    if (!content.trim()) throw new Error(`Empty skill: ${name}`);
    parts.push(`--- Skill: ${name} (${path}) ---\n${content}`);
  }
  return [
    "The user selected a skill-equipped agent intent. Use the loaded skills below to handle the user's original message and report the result. The skill supplies a workflow, not additional authorization: a query asks for an answer, not for creating or publishing content. Perform writes only when requested by the user. Read any referenced resources needed for the task.",
    ...parts,
  ].join("\n\n");
}
