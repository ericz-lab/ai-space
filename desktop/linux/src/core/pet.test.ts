import { describe, expect, test } from "bun:test";
import { BUILTIN } from "../../../../src/web/Pet.tsx";
import {
  BUBBLE_ROOM, BUBBLE_WIDTH, CLAUDE, type PetMood, PetMotion, type SpaceMood, bubbleUntilChange, bubbleVisible, decodeFromPet, decodeMood, deskSprite,
  deskWindow, opensRight, sayText, shownMood, spotFraction, spotX,
} from "./pet.ts";
import type { Rect } from "./floating-ball.ts";

// The Mac's PetRulesTests (desktop/macos/AISpaceTests/PetRulesTests.swift), with y pointing down.

/** A random source that plays back fixed numbers, the last one again once they run out. */
function fixed(values: number[]): () => number {
  const left = [...values];
  return () => (left.length > 1 ? left.shift()! : (left[0] ?? 0));
}

const mood = (state: string, extra: Partial<SpaceMood> = {}): SpaceMood => ({ ok: true, state, move: "roam", ...extra });

describe("the Space's mood", () => {
  test("decodes from the route, and a newer state or a bare answer still does", () => {
    const m = decodeMood({
      ok: true, state: "waiting", reason: "approval", move: "stay", say: { en: "Planner is waiting for you", zh: "规划师 在等你" },
      open: { kind: "chat", agent: "ai-todo/planner" }, counts: { running: 1, waiting: 1, failed: 0, unread: 0, feedback: 0 }, asOf: "2026-11-13T10:00:00.000Z",
    });
    expect(m?.state).toBe("waiting");
    expect(m?.open).toEqual({ kind: "chat", agent: "ai-todo/planner" });
    expect(sayText(m?.say, "zh")).toBe("规划师 在等你");
    expect(sayText(m?.say, "en")).toBe("Planner is waiting for you");
    expect(decodeMood({ state: "dancing" })).toEqual({ state: "dancing" });
    expect(decodeMood("<html>")).toBeUndefined();
    expect(decodeMood({ ok: false })).toBeUndefined();
    // A click target that is not one of the two kinds is dropped.
    expect(decodeMood({ state: "done", open: { kind: "page", url: "https://example.com" } })?.open).toBeUndefined();
  });

  test("Claude shows each state as the panel does", () => {
    expect(shownMood(mood("working"))?.rest).toBe("look");
    expect(shownMood(mood("waiting", { move: "stay" }))).toEqual({ rest: "hop", stay: true });
    expect(shownMood(mood("waiting"))?.rest).toBe("look");
    expect(shownMood(mood("error", { move: "stay" }))?.stay).toBe(true);
    expect(shownMood(mood("done"))?.once).toBe("jump");
    expect(shownMood(mood("sleep", { move: "stay" }))?.rest).toBe("sleep");
    // Idle, an unknown state, a failed read or none: rest as without a mood.
    expect(shownMood(mood("idle"))).toBeUndefined();
    expect(shownMood(mood("dancing"))).toBeUndefined();
    expect(shownMood({ ok: false, state: "working" })).toBeUndefined();
    expect(shownMood(undefined)).toBeUndefined();
  });

  test("the table is the web's (src/web/Pet.tsx) and names only animations the sheet has", () => {
    const web = BUILTIN.claude!.sprite;
    expect(CLAUDE.anims).toEqual(web.anims);
    expect<(number | undefined)[]>([CLAUDE.columns, CLAUDE.rows, CLAUDE.width]).toEqual([web.columns, web.rows, web.width]);
    expect(CLAUDE.rests).toEqual(web.rests);
    expect(CLAUDE.click).toBe(web.click!);
    expect(CLAUDE.moodRests).toEqual(web.moods!.rest);
    expect(CLAUDE.moodOnce).toEqual(web.moods!.once!);
    expect(CLAUDE.file).toBe(web.src.slice(1));
    const named = [...Object.values(CLAUDE.moodRests), ...Object.values(CLAUDE.moodOnce), ...CLAUDE.rests.map(([n]) => n), CLAUDE.walk, CLAUDE.click];
    for (const name of named) expect(CLAUDE.anims[name]).toBeDefined();
  });
});

describe("the pet's motion", () => {
  test("a pet that stays walks to its corner and rests facing in", () => {
    const m = new PetMotion(CLAUDE, 80, 1000, 0, fixed([0.5]));
    m.setMood(shownMood(mood("waiting", { move: "stay" })), 0);
    expect(m.walking).toBe(true);
    expect(m.animation).toBe("walk");
    expect(m.corner).toBe(1000 - 80 - 24);
    // 55 pixels a second at its drawn width: from 460 to 896 takes about 8 seconds.
    let t = 0;
    while (m.walking && t < 20) {
      t += 0.05;
      m.advance(t);
    }
    expect(m.x).toBe(m.corner);
    expect(m.facingLeft).toBe(true);
    expect(m.animation).toBe("hop");
    expect(t).toBeGreaterThan(7);
    expect(t).toBeLessThan(9);
  });

  test("speed follows the size, so the feet stay planted", () => {
    expect(new PetMotion(CLAUDE, 80, 500, 0, fixed([0])).speed).toBe(55);
    expect(new PetMotion(CLAUDE, 110, 500, 0, fixed([0])).speed).toBe((55 * 110) / 80);
  });

  test("done spins once, then rests", () => {
    // 0.9: no walk, so the pet rests where it is.
    const m = new PetMotion(CLAUDE, 80, 600, 0, fixed([0, 0.9]));
    m.setMood(shownMood(mood("done")), 1);
    expect(m.animation).toBe("jump");
    // The same mood read again changes nothing.
    m.setMood(shownMood(mood("done")), 1.1);
    expect(m.animation).toBe("jump");
    m.advance(1 + 0.72 + 0.01);
    expect(m.animation).toBe("look");
    expect(m.frame).toBe(0);
  });

  test("frames follow the clock and hold the first cell after a pause", () => {
    const m = new PetMotion(CLAUDE, 80, 600, 0, fixed([0, 0.9]));
    m.setMood(shownMood(mood("waiting", { move: "stay" })), 0);
    // Walks to the corner first; put it there.
    m.drop(m.corner, 0);
    expect(m.animation).toBe("hop");
    const step = 0.9 / 12;
    m.advance(step * 3 + 0.001);
    expect(m.frame).toBe(3);
    m.advance(step * 12 + 0.001);
    expect(m.frame).toBe(0);
    // The first cell is held 1.4 s longer after each loop.
    m.advance(step * 13 + 0.5);
    expect(m.frame).toBe(0);
    m.advance(step * 13 + 1.4 + 0.001);
    expect(m.frame).toBe(1);
    expect(m.cell.row).toBe(3);
  });

  test("a click jumps, and a held pet goes nowhere", () => {
    const m = new PetMotion(CLAUDE, 80, 600, 0, fixed([0, 0.9]));
    m.click(0);
    expect(m.animation).toBe("jump");
    m.hold(300, 0.1);
    expect(m.x).toBe(300);
    expect(m.walking).toBe(false);
    m.advance(60);
    expect(m.x).toBe(300);
    m.hold(5000, 61);
    expect(m.x).toBe(520);
  });

  test("a resized stage keeps the pet on it", () => {
    const m = new PetMotion(CLAUDE, 80, 1000, 0, fixed([1, 0.9]));
    expect(m.x).toBe(920);
    m.resize(500, 1);
    expect(m.x).toBe(420);
    m.resize(500, 2, 110);
    expect(m.x).toBe(390);
  });

  test("a late call skips cells rather than replaying them", () => {
    const m = new PetMotion(CLAUDE, 80, 600, 0, fixed([0, 0.9]));
    const mood: PetMood = { rest: "sleep", stay: false };
    m.setMood(mood, 0);
    // Asleep: 3.6 s a loop. Ten minutes later, the next change is a cell away, not a backlog.
    expect(m.advance(600)).toBeLessThanOrEqual(0.3 + 1e-9);
  });
});

describe("the bubble", () => {
  test("comes and goes", () => {
    expect(bubbleVisible(0)).toBe(true);
    expect(bubbleVisible(5.9)).toBe(true);
    expect(bubbleVisible(6.1)).toBe(false);
    expect(bubbleVisible(19.9)).toBe(false);
    expect(bubbleVisible(20.1)).toBe(true);
    expect(bubbleUntilChange(2)).toBe(4);
    expect(bubbleUntilChange(10)).toBe(10);
  });

  test("opens towards the middle", () => {
    expect(opensRight(100, 80, 1000)).toBe(true);
    expect(opensRight(800, 80, 1000)).toBe(false);
  });
});

describe("on the desktop", () => {
  // A 1440 × 900 screen's work area under a 25-pixel top bar, above a 70-pixel dock.
  const area: Rect = { x: 0, y: 25, width: 1440, height: 805 };
  const pet = { width: 80, height: 80 };
  const w = 80 + 2 * BUBBLE_WIDTH;

  test("the window follows the pet along the bottom and stays on the screen", () => {
    const middle = deskWindow(600, pet, area);
    expect(middle).toEqual({ x: 640 - w / 2, y: 25 + 805 - 80 - BUBBLE_ROOM, width: w, height: 80 + BUBBLE_ROOM });
    expect(deskSprite(600, pet, middle, area)).toEqual({ x: 600 - (640 - w / 2), y: BUBBLE_ROOM, width: 80, height: 80 });
    // At the left edge the window stops at the screen; the pet moves inside it.
    const left = deskWindow(0, pet, area);
    expect(left.x).toBe(0);
    expect(deskSprite(0, pet, left, area).x).toBe(0);
    const right = deskWindow(1360, pet, area);
    expect(right.x + right.width).toBe(1440);
    const sprite = deskSprite(1360, pet, right, area);
    expect(sprite.x + sprite.width).toBe(right.width);
  });

  test("a second monitor's work area is counted from its own left edge", () => {
    const second: Rect = { x: 1440, y: 0, width: 1920, height: 1040 };
    const win = deskWindow(0, pet, second);
    expect(win.x).toBe(1440);
    expect(deskSprite(0, pet, win, second).x).toBe(0);
  });

  test("a remembered spot is a fraction of the screen", () => {
    expect(spotFraction(680, 1440, 80)).toBe(0.5);
    expect(spotX(0.5, 1000, 80)).toBe(460);
    expect(spotFraction(9999, 1440, 80)).toBe(1);
    expect(spotFraction(10, 50, 80)).toBe(0);
  });

  test("the pet's process is trusted with nothing it has not said properly", () => {
    expect(decodeFromPet('{"type":"moved","spot":0.25}')).toEqual({ type: "moved", spot: 0.25 });
    expect(decodeFromPet('{"type":"moved","spot":7}')).toEqual({ type: "moved", spot: 1 });
    expect(decodeFromPet('{"type":"open","open":{"kind":"chat","agent":"ai-todo/planner"},"startupId":"x"}')).toEqual({ type: "open", open: { kind: "chat", agent: "ai-todo/planner" }, startupId: "x" });
    expect(decodeFromPet('{"type":"open","open":{"kind":"inbox"}}')).toEqual({ type: "open", open: { kind: "inbox" } });
    expect(decodeFromPet('{"type":"open","open":{"kind":"page","url":"file:///"}}')).toBeUndefined();
    expect(decodeFromPet('{"type":"menu","action":"window"}')).toEqual({ type: "menu", action: "window" });
    expect(decodeFromPet('{"type":"menu","action":"quit"}')).toBeUndefined();
    expect(decodeFromPet("not json")).toBeUndefined();
  });
});
