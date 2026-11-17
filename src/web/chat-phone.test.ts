import { expect, test } from "bun:test";

// The chat's phone layout (styles.css, at 640 px and below): the agent's icon shows in the avatar
// bar on the left only, never again in the head or in an empty conversation's greeting.
const css = await Bun.file(new URL("./styles.css", import.meta.url)).text();
const phoneChat = css
  .split("@media (max-width: 640px) {")
  .slice(1)
  .map((rest) => rest.slice(0, rest.indexOf("\n}")))
  .find((body) => body.includes(".chat-name")) ?? "";

test("on a phone the chat's head and greeting leave the agent's icon to the avatar bar", () => {
  expect(phoneChat).toContain(".chat .chat-ava, .chat .hello-ava { display: none; }");
  // Wider screens keep the head's icon: the rule lives in the phone block only.
  expect(css.split("\n").filter((line) => line.includes("display: none") && line.includes(".chat-ava"))).toHaveLength(1);
  expect(css).toMatch(/^\.chat-ava \{[^}]*display: inline-flex/m);
});
