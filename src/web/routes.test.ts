import { expect, test } from "bun:test";
import { createWebRoutes } from "./routes.ts";

test("backdrop documents revalidate while other public assets keep their cache lifetime", async () => {
  const server = Bun.serve({ port: 0, routes: createWebRoutes() });
  try {
    for (const name of ["orbit", "northern", "papercut", "prism"]) {
      for (const query of ["", "?v=2"]) {
        const response = await fetch(new URL(`/backdrops/${name}.html${query}`, server.url));
        expect(response.status).toBe(200);
        expect(response.headers.get("cache-control")).toBe("no-cache");
        expect(response.headers.get("content-type")).toContain("text/html");
        expect(await response.text()).toContain("<svg");
      }
    }
    const icon = await fetch(new URL("/favicon.svg", server.url));
    expect(icon.headers.get("cache-control")).toBe("public, max-age=86400");
  } finally {
    await server.stop(true);
  }
});
