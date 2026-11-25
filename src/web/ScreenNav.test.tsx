import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import ScreenNav, { PhoneNav } from "./ScreenNav.tsx";

const noop = () => {};
const css = await Bun.file(new URL("./styles.css", import.meta.url)).text();
/** The body of the first `@media <query>` block whose text contains `needle`. */
const media = (query: string, needle: string) =>
  css
    .split(`@media ${query} {`)
    .slice(1)
    .map((rest) => rest.slice(0, rest.indexOf("\n}")))
    .find((body) => body.includes(needle)) ?? "";
const phone = "(hover: none) and (max-width: 640px)";

test("a phone's row at the top has the dock's buttons, the current one marked", () => {
  const html = renderToStaticMarkup(<PhoneNav pos={1} names={["Home", "Screen 2"]} onGo={noop} onNew={noop} onSearch={noop} />);
  expect(html).toStartWith('<nav class="phone-nav" aria-label="Screens">');
  const labels = [...html.matchAll(/aria-label="([^"]+)"/g)].map((m) => m[1]);
  expect(labels).toEqual(["Screens", "Library", "Home", "Screen 2", "New screen", "Search"]);
  expect(html).toContain('class="dock-btn dock-screen on" aria-label="Screen 2" aria-current="page"');
  expect(html).not.toContain("dock ");
});

test("the dock keeps the same buttons", () => {
  const html = renderToStaticMarkup(<ScreenNav pos={0} names={["Home"]} onGo={noop} onNew={noop} onSearch={noop} />);
  expect(html).toContain('<nav class="dock');
  expect(html).toContain('class="dock-btn on" aria-label="Home" aria-current="page"');
  expect(html).toContain('aria-label="Search"');
});

test("a phone shows no dock, only the row at the top; other screens never show the row", () => {
  expect(css).toContain(".phone-nav { display: none; }");
  const rules = media(phone, ".phone-nav");
  expect(rules).toContain(".dock { display: none; }");
  expect(rules).toMatch(/\.phone-nav \{ display: flex;/);
  // The row is in the page's flow: never fixed or sticky over the content.
  expect(rules).not.toMatch(/position: (fixed|sticky)/);
  // Other touch screens and mice keep the dock as it was.
  expect(css).toContain("@media (hover: none) { .dock { transform: translateX(-50%); opacity: 1; } }");
  expect(css).not.toContain(".dock.away");
});
