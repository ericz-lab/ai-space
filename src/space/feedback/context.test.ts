import { describe, expect, test } from "bun:test";
import { clientLabel, clientOf } from "./client.ts";
import { cleanHtml, cleanUrl, parseContext, parseImages, redact } from "./context.ts";
import { LIMITS } from "./types.ts";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]).toString("base64");
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]).toString("base64");

describe("redact", () => {
  test("hides what looks like a credential, keeps the words around it", () => {
    const text = [
      "Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345",
      "key sk-ant-REDACTEDabcdefghijklmnop and ghp_abcdefghijklmnopqrstuvwxyz0123",
      "jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
      'password = "hunter22" token: abc123',
      "the button is too small",
    ].join("\n");
    const out = redact(text);
    expect(out).not.toContain("abcdefghijklmnopqrstuvwxyz012345");
    expect(out).not.toContain("sk-ant-");
    expect(out).not.toContain("ghp_");
    expect(out).not.toContain("eyJhbGci");
    expect(out).not.toContain("hunter22");
    expect(out).not.toContain("abc123");
    expect(out).toContain("Bearer [redacted]");
    expect(out).toContain("the button is too small");
  });
});

describe("cleanUrl", () => {
  test("drops credentials and secret-looking parameters, keeps the page", () => {
    expect(cleanUrl("https://user:pw@todo.example.com/list?view=review&token=abc&sort=new")).toBe("https://todo.example.com/list?view=review&token=redacted&sort=new");
    expect(cleanUrl("https://todo.example.com/#access_token=xyz&state=1")).toBe("https://todo.example.com/#access_token=redacted&state=1");
    expect(cleanUrl("https://todo.example.com/#section-2")).toBe("https://todo.example.com/#section-2");
    expect(cleanUrl("javascript:alert(1)")).toBe("");
    expect(cleanUrl("not a url")).toBe("");
  });
});

describe("cleanHtml", () => {
  test("keeps structure and text, drops scripts, handlers, values and secrets", () => {
    const html = '<form onsubmit="steal()"><input type="password" value="hunter22" data-token="t0k3n"><button class="add" onclick="go()">Add value</button><script>alert(1)</script><style>p{}</style></form>';
    const out = cleanHtml(html);
    expect(out).toBe('<form><input type="password"><button class="add">Add value</button></form>');
  });

  test("is bounded", () => {
    expect(cleanHtml(`<div>${"x".repeat(10_000)}</div>`).length).toBe(LIMITS.elementHtml);
  });
});

describe("parseContext", () => {
  test("types and bounds every field; unknown ones are dropped", () => {
    const c = parseContext({
      url: "https://todo.example.com/?view=review&session=s3cr3t",
      title: "AI Todo",
      viewport: { w: 375, h: 812, dpr: 3 },
      touch: true,
      theme: "dark",
      lang: "zh-CN",
      elements: [{ selector: "button.add-task", tag: "BUTTON", text: "Add", html: '<button onclick="x()">Add</button>', rect: { x: 10, y: 20, w: 100, h: 44 } }, { tag: "div" }],
      errors: ["TypeError: x is undefined", 42],
      tz: "Asia/Shanghai",
      cookie: "a=b",
    });
    expect(c).toEqual({
      url: "https://todo.example.com/?view=review&session=redacted",
      path: "/?view=review&session=redacted",
      title: "AI Todo",
      viewport: { w: 375, h: 812, dpr: 3 },
      touch: true,
      theme: "dark",
      lang: "zh-CN",
      elements: [{ selector: "button.add-task", tag: "button", text: "Add", html: "<button>Add</button>", rect: { x: 10, y: 20, w: 100, h: 44 } }],
      errors: ["TypeError: x is undefined"],
      tz: "Asia/Shanghai",
    });
  });

  test("anything else becomes an empty, light context", () => {
    expect(parseContext("nope")).toMatchObject({ url: "", path: "", theme: "light", lang: "", elements: [], errors: [], tz: "" });
    expect(parseContext({ lang: "<script>", tz: "../../etc", elements: Array(20).fill({ selector: "a" }) }).elements.length).toBe(LIMITS.elements);
  });
});

describe("parseImages", () => {
  test("accepts PNG, JPEG and WebP by their bytes, named after their type", () => {
    const imgs = parseImages([{ name: "shot one.png", data: `data:image/png;base64,${PNG}` }, { name: "photo.png", data: JPEG }]);
    expect(imgs.map((i) => [i.name, i.type])).toEqual([["shot-one.png", "image/png"], ["photo.jpg", "image/jpeg"]]);
    expect(parseImages(undefined)).toEqual([]);
  });

  test("refuses anything else", () => {
    expect(() => parseImages([{ data: Buffer.from("<svg/>").toString("base64") }])).toThrow("not a PNG");
    expect(() => parseImages([{ data: "%%%" }])).toThrow("base64");
    expect(() => parseImages([{ data: PNG }, { data: PNG }, { data: PNG }])).toThrow("at most 2");
    expect(() => parseImages("x")).toThrow("list");
    const big = Buffer.alloc(LIMITS.imageBytes + 1);
    big.set([0x89, 0x50, 0x4e, 0x47]);
    expect(() => parseImages([{ data: big.toString("base64") }])).toThrow("larger than");
  });
});

describe("clientOf", () => {
  const CHROME_LINUX = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
  const SAFARI_IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
  test("tells the native clients by their tokens", () => {
    expect(clientOf(`Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15 AISpaceLinux/0.9.1`)).toEqual({ kind: "linux-client", os: "Linux", browser: "webview", version: "0.9.1" });
    expect(clientOf("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 AISpaceDesktop/1.2").kind).toBe("mac-client");
    expect(clientOf(`${SAFARI_IPHONE} AISpaceMobile/1.0`).kind).toBe("iphone-client");
    expect(clientOf("Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/130 Mobile Safari/537.36 AISpaceMobile/1.0").kind).toBe("android-client");
    expect(clientOf("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0 AISpaceWindows/0.1.0")).toEqual({ kind: "windows-client", os: "Windows", browser: "webview", version: "0.1.0" });
  });

  test("anything else is a browser on a desktop, a phone or a tablet", () => {
    expect(clientOf(CHROME_LINUX)).toEqual({ kind: "desktop-browser", os: "Linux", browser: "Chrome" });
    expect(clientOf(SAFARI_IPHONE)).toEqual({ kind: "phone-browser", os: "iOS", browser: "Safari" });
    expect(clientOf("Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Safari/604.1").kind).toBe("tablet-browser");
    expect(clientOf("").kind).toBe("desktop-browser");
  });

  test("reads in both languages", () => {
    const c = clientOf(CHROME_LINUX);
    expect(clientLabel(c)).toBe("Desktop browser (Chrome · Linux)");
    expect(clientLabel(c, "zh")).toBe("桌面浏览器 (Chrome · Linux)");
    expect(clientLabel(clientOf("x AISpaceLinux/1"), "zh")).toBe("Linux 客户端");
    expect(clientLabel(clientOf("x AISpaceWindows/1"))).toBe("Windows client");
  });
});
