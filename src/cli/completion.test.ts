import { expect, test } from "bun:test";
import { renderCompletion } from "./completion.ts";
import { NOUNS } from "./main.ts";
import { runCli } from "./testing.ts";
import { UsageError } from "./types.ts";

test("the completion scripts name every noun and verb", () => {
  for (const shell of ["zsh", "bash"]) {
    const s = renderCompletion(shell, NOUNS);
    for (const n of NOUNS) {
      expect(s).toContain(n.name);
      if (Object.keys(n.verbs).length > 1) for (const v of Object.keys(n.verbs)) expect(s).toContain(v);
    }
  }
  expect(renderCompletion("zsh", NOUNS)).toStartWith("#compdef space");
  expect(renderCompletion("bash", NOUNS)).toContain("complete -o default -F _space space");
  expect(() => renderCompletion("fish", NOUNS)).toThrow(UsageError);
});

test("space completion zsh prints the script", async () => {
  const r = await runCli(["completion", "zsh"]);
  expect(r.code).toBe(0);
  expect(r.out[0]).toBe("#compdef space");
});
