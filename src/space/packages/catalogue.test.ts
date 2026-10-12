import { expect, test } from "bun:test";
import { RemoteCatalogue } from "./catalogue.ts";
import type { PackageLinks } from "./links.ts";

type Conn = { id: string; remoteSpaceId: string; enabled: boolean };

function fake(conns: Conn[], answer: (id: string) => Response) {
  const listeners = new Set<(id: string) => void>();
  const links = {
    connections: {
      list: () => conns,
      get: (id: string) => conns.find((c) => c.id === id),
      onChange: (fn: (id: string) => void) => { listeners.add(fn); return () => listeners.delete(fn); },
    },
    request: async (id: string) => answer(id),
  } as unknown as PackageLinks;
  return { links, changed: () => { for (const fn of listeners) fn("c1"); } };
}

const SPACE = "0d8ce940-9bc8-4082-bab2-0ccb7e5dbd87";

test("lists a connected Space's shared apps as tiles named after that Space", async () => {
  const { links } = fake([{ id: "c1", remoteSpaceId: SPACE, enabled: true }], () => Response.json({
    spaceId: SPACE, name: "david",
    apps: [{ app: "voice-chat", title: "Voice chat", version: "0.1.0", page: true }, { app: "nightly", title: "Nightly", version: "1.0.0", page: false }, { app: "../bad", title: "x", version: "1" }],
  }));
  const catalogue = new RemoteCatalogue(links, { refreshMs: 3_600_000 });
  try {
    await catalogue.refresh();
    const views = catalogue.views(new Set(["david/nightly"]));
    expect(views.map((v) => v.id)).toEqual(["david/voice-chat", "david/nightly"]);
    expect(views[0]).toMatchObject({ name: "voice-chat", peer: "david", connection: "c1", stale: false, title: "Voice chat", url: "/_space/connections/c1/apps/voice-chat", hidden: false });
    expect(views[1]!.url).toBeUndefined();
    expect(views[1]!.hidden).toBe(true);
  } finally { catalogue.close(); }
});

test("keeps the last known apps as stale while the Space does not answer and drops them with the connection", async () => {
  const conns: Conn[] = [{ id: "c1", remoteSpaceId: SPACE, enabled: true }];
  let up = true;
  const { links, changed } = fake(conns, () => {
    if (!up) throw new Error("connection unavailable");
    return Response.json({ spaceId: SPACE, apps: [{ app: "voice-chat", title: "Voice chat", version: "0.1.0" }] });
  });
  const catalogue = new RemoteCatalogue(links, { refreshMs: 3_600_000 });
  try {
    await catalogue.refresh();
    // No name in the answer: the tile is labelled with the start of the Space's UUID.
    expect(catalogue.views(new Set()).map((v) => [v.id, v.stale])).toEqual([["0d8ce940/voice-chat", false]]);
    up = false;
    await catalogue.refresh();
    expect(catalogue.views(new Set()).map((v) => [v.id, v.stale])).toEqual([["0d8ce940/voice-chat", true]]);
    conns[0]!.enabled = false;
    changed();
    expect(catalogue.views(new Set())).toEqual([]);
  } finally { catalogue.close(); }
});

test("ignores a catalogue answered by another Space than the connection names", async () => {
  const { links } = fake([{ id: "c1", remoteSpaceId: SPACE, enabled: true }], () => Response.json({ spaceId: "c551f57b-96e5-4abe-a6c4-11f5f478011b", name: "other", apps: [{ app: "voice-chat", title: "Voice chat", version: "0.1.0" }] }));
  const catalogue = new RemoteCatalogue(links, { refreshMs: 3_600_000 });
  try {
    await catalogue.refresh();
    expect(catalogue.views(new Set())).toEqual([]);
  } finally { catalogue.close(); }
});
