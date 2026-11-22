import { useEffect, useRef, useState } from "react";
import { useLang } from "./i18n.ts";
import type { Key } from "./messages.ts";

// Desk pet: a sprite sheet the panel walks along the bottom edge. The pets bundled with the panel are
// in BUILTIN; at present that is Claude alone, a 3D model rendered into a sheet by pets/claude.ts. It shows the Space's mood (/api/pets/mood, docs/app-spec.md#space-mood) as
// the native clients' pets do (desktop/macos/AISpace/Services/PetRules.swift holds the same table).
// The sheet is an <img> moved inside a clipping box rather than a CSS background.

/** `pause`: the first cell is held this much longer after each loop (a hop in bursts). */
export type PetAnimation = { row: number; frames: number; ms: number; pause?: number };

/** A mood as the page draws it: the animation to rest in, one played once as it begins, and what a click does. */
type ShownMood = { animation: string; move: "roam" | "stay"; say?: Record<string, string>; once?: string; open?: () => void };

/** The Space's mood as GET /api/pets/mood answers it. */
export type SpaceMood = {
  ok: boolean;
  state: "working" | "waiting" | "error" | "done" | "idle" | "sleep";
  reason?: string;
  move: "roam" | "stay";
  say?: Record<string, string>;
  open?: { kind: "chat"; agent: string } | { kind: "inbox" };
};

/** How to draw and move the sheet. */
type Sprite = {
  src: string;
  columns: number;
  rows: number;
  width: number;
  anims: Record<string, PetAnimation>;
  /** Walking right; walking left is this mirrored, and so is the rest after it. */
  right: string;
  /** Rest animations to pick from when there is no mood, with their weights. */
  rests: [string, number][];
  /** Played once on a click when the mood opens nothing. */
  click?: string;
  /**
   * How the Space's mood shows: the animation the pet rests in for each state (`<state>/stay` when it
   * waits in its corner; a state not listed rests as without a mood), and one played once as a state begins.
   */
  moods?: { rest: Record<string, string>; once?: Record<string, string> };
};

/**
 * Claude: the 3D mascot rendered by pets/claude.py, whose ANIMS this repeats (pet-claude.test.ts compares them).
 * Its scuttle is drawn for this width and SPEED, so its feet stay planted; change them together with
 * claude.py and re-render.
 */
const CLAUDE: Sprite = {
  src: "/pet-claude.webp",
  columns: 12,
  rows: 5,
  width: 80,
  anims: {
    walk: { row: 0, frames: 8, ms: 320 },
    sleep: { row: 1, frames: 12, ms: 3600 },
    look: { row: 2, frames: 12, ms: 2880 },
    hop: { row: 3, frames: 12, ms: 900, pause: 1400 },
    jump: { row: 4, frames: 12, ms: 720 },
  },
  right: "walk",
  rests: [["look", 0.5], ["sleep", 0.38], ["hop", 0.12]],
  click: "jump",
  moods: { rest: { working: "look", waiting: "look", "waiting/stay": "hop", error: "look", done: "look", sleep: "sleep" }, once: { done: "jump" } },
};
/** Pets bundled with the panel, by the name kept in the preferences (`petBuiltin`). A new one is a sheet and an entry here. */
export const BUILTIN: Record<string, { title: Key; sprite: Sprite }> = { claude: { title: "pet.builtin.claude", sprite: CLAUDE } };
/** The pet shown when none is chosen, or the chosen one is gone. */
export const DEFAULT_PET = "claude";
const SPEED = 55; // px/s
// The bubble comes and goes: shown this long, then hidden this long, again while the line stays.
const SAY_SHOW_MS = 6_000;
const SAY_HIDE_MS = 14_000;

type Cell = { w: number; h: number };

/** A pet bundled with the panel, by its name in BUILTIN; one with `moods` shows the Space's mood. */
export default function Pet({ name }: { name: string }) {
  const sprite = BUILTIN[name]?.sprite;
  const space = useSpaceMood(!!sprite?.moods);
  return sprite ? <SpritePet sprite={sprite} mood={sprite.moods && space ? shownMood(sprite.moods, space) : null} /> : null;
}

/** The Space's mood, read every 30 seconds while the page is visible; null until read, or when it cannot be. */
function useSpaceMood(on: boolean): SpaceMood | null {
  const [mood, setMood] = useState<SpaceMood | null>(null);
  useEffect(() => {
    setMood(null);
    if (!on) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = () => {
      clearTimeout(timer);
      if (document.visibilityState === "visible")
        fetch("/api/pets/mood")
          .then((r) => r.json())
          .then((j: SpaceMood) => live && setMood(j.ok ? j : null))
          .catch(() => live && setMood(null));
      timer = setTimeout(read, 30_000);
    };
    const onVisible = () => document.visibilityState === "visible" && read();
    read();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      live = false;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [on]);
  return mood;
}

/** A Space mood in a sprite's terms; null (rest as without a mood) for a state the sprite does not list. */
function shownMood(moods: NonNullable<Sprite["moods"]>, m: SpaceMood): ShownMood | null {
  const animation = (m.move === "stay" ? moods.rest[`${m.state}/stay`] : undefined) ?? moods.rest[m.state];
  if (!animation) return null;
  const once = moods.once?.[m.state];
  const target = m.open;
  return {
    animation,
    move: m.move,
    ...(m.say ? { say: m.say } : {}),
    ...(once ? { once } : {}),
    // The panel's own windows open from its address's fragment (panel-link.ts).
    ...(target ? { open: () => void (location.hash = target.kind === "inbox" ? "inbox" : `chat=${encodeURIComponent(target.agent)}`) } : {}),
  };
}

function SpritePet({ sprite, mood = null }: { sprite: Sprite; mood?: ShownMood | null }) {
  const { t, lang } = useLang();
  const [loaded, setLoaded] = useState<{ src: string; cell: Cell } | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const clip = useRef<HTMLElement>(null);
  const spr = useRef<HTMLImageElement>(null);
  const sayEl = useRef<HTMLSpanElement>(null);
  // The walker reads these through refs, so a new mood or a new sprite object never resets its position.
  const spriteRef = useRef(sprite);
  spriteRef.current = sprite;
  const moodRef = useRef(mood);
  const onMood = useRef<(() => void) | null>(null);
  const moodKey = mood ? `${mood.animation}/${mood.move}/${mood.once ?? ""}` : "";
  useEffect(() => {
    moodRef.current = mood;
  });
  useEffect(() => {
    onMood.current?.();
  }, [moodKey]);

  // A new line shows at once; then the bubble comes and goes. Pointing at the pet shows it too.
  const say = mood?.say ? pickLine(mood.say, lang) : "";
  const [bubble, setBubble] = useState(false);
  const [hover, setHover] = useState(false);
  useEffect(() => {
    setBubble(!!say);
    if (!say) return;
    let on = true;
    let timer: ReturnType<typeof setTimeout>;
    const flip = () => {
      on = !on;
      setBubble(on);
      timer = setTimeout(flip, on ? SAY_SHOW_MS : SAY_HIDE_MS);
    };
    timer = setTimeout(flip, SAY_SHOW_MS);
    return () => clearTimeout(timer);
  }, [say]);

  // Load the sheet off-screen to learn its cell size; nothing shows when it cannot be loaded.
  const { src, columns, rows } = sprite;
  useEffect(() => {
    let live = true;
    const img = new Image();
    img.onload = () => live && setLoaded({ src, cell: { w: img.naturalWidth / columns, h: img.naturalHeight / rows } });
    img.onerror = () => live && setLoaded(null);
    img.src = src;
    return () => {
      live = false;
    };
  }, [src, columns, rows]);

  const ok = loaded !== null;
  const CW = loaded?.cell.w ?? 1;
  const CH = loaded?.cell.h ?? 1;
  const W = sprite.width;
  const scale = W / CW;
  useEffect(() => {
    if (!ok || !box.current || !spr.current || !clip.current) return;
    const sp = () => spriteRef.current;
    let x = Math.random() * Math.max(0, innerWidth - W);
    let state = sp().rests[0]![0];
    let facing: "right" | "left" = "right";
    let frame = 0;
    let target = x;
    let oneShot: (() => void) | null = null;
    let frameTimer: ReturnType<typeof setTimeout> | undefined;
    let run = 0; // which setState call the frame timer belongs to
    let behaveTimer: ReturnType<typeof setTimeout> | undefined;
    const walking = () => state === sp().right;

    const draw = () => {
      if (!spr.current || !box.current || !clip.current) return;
      const a = sp().anims[state];
      if (!a) return;
      spr.current.style.transform = `translate(${-frame * CW}px, ${-a.row * CH}px)`;
      clip.current.style.transform = facing === "left" ? `translateX(${W}px) scale(${-scale}, ${scale})` : `scale(${scale})`;
      box.current.style.transform = `translate3d(${x}px,0,0)`;
      // The bubble opens towards the middle of the page, so it never runs off an edge.
      box.current.dataset.side = x + W / 2 > innerWidth / 2 ? "right" : "left";
    };
    // A loop of an animation with a pause starts a burst: the bubble gives a small hop with it.
    const beat = () => sayEl.current?.animate([{ scale: "1" }, { scale: "1.06" }, { scale: "1" }], { duration: 180, easing: "ease-out" });
    const setState = (s: string) => {
      const a = sp().anims[s];
      if (!a) return;
      state = s;
      frame = 0;
      clearTimeout(frameTimer);
      const mine = ++run;
      const step = a.ms / a.frames;
      // Each cell shows for `step`; after a loop the first cell is held `pause` longer.
      const tick = () => {
        frame += 1;
        if (frame >= a.frames) {
          frame = 0;
          if (oneShot) {
            const done = oneShot;
            oneShot = null;
            done();
            // The one-shot moved on to another animation, which runs its own timer.
            if (run !== mine) return;
          }
        }
        if (frame === 1 && a.pause) beat();
        draw();
        frameTimer = setTimeout(tick, frame === 0 && a.pause ? step + a.pause : step);
      };
      frameTimer = setTimeout(tick, step);
      draw();
    };
    const pickRest = () => {
      const m = moodRef.current;
      if (m && sp().anims[m.animation]) return m.animation;
      let r = Math.random();
      for (const [name, w] of sp().rests) {
        if ((r -= w) <= 0) return name;
      }
      return sp().rests[0]![0];
    };
    // Where a pet that stays waits: the bottom-right corner, clear of the dock, easy to find.
    const corner = () => Math.max(0, innerWidth - W - 24);
    const walkTo = (to: number) => {
      target = to;
      facing = target > x ? "right" : "left";
      setState(sp().right);
    };
    // Walk somewhere, or rest; a mood that says "stay" sends the pet to its corner and keeps it there,
    // facing into the page.
    const behave = () => {
      clearTimeout(behaveTimer);
      oneShot = null;
      const m = moodRef.current;
      if (m?.move === "stay") {
        if (Math.abs(x - corner()) > 2) return walkTo(corner());
        facing = "left";
        return setState(pickRest());
      }
      const calm = !!m; // a pet with a mood rests longer between walks
      if (Math.random() < (calm ? 0.3 : 0.45)) walkTo(Math.random() * Math.max(0, innerWidth - W));
      else {
        setState(pickRest());
        behaveTimer = setTimeout(behave, calm ? 6000 + Math.random() * 10_000 : 1800 + Math.random() * 3500);
      }
    };
    // Play an animation once, then go on as before; false when the sprite lacks it or plays it already.
    const playOnce = (name: string | undefined) => {
      if (!name || state === name || !sp().anims[name]) return false;
      clearTimeout(behaveTimer);
      oneShot = behave;
      setState(name);
      return true;
    };
    // A new mood may begin with an animation played once (Claude spins when a turn is done).
    onMood.current = () => {
      if (!playOnce(moodRef.current?.once)) behave();
    };
    const mover = setInterval(() => {
      if (!walking()) return;
      x += (SPEED / 25) * (facing === "right" ? 1 : -1);
      if ((facing === "right" && x >= target) || (facing === "left" && x <= target)) {
        x = target;
        behave();
      }
      draw();
    }, 40);
    // Click: open what the mood points at, or play the click animation once.
    const el = box.current;
    const click = () => {
      const open = moodRef.current?.open;
      if (open) return open();
      playOnce(sp().click);
    };
    el.addEventListener("click", click);
    // A resized window moves the corner: a pet that stays follows it.
    const onResize = () => {
      if (moodRef.current?.move === "stay" && !walking()) behave();
    };
    addEventListener("resize", onResize);

    behave();
    return () => {
      onMood.current = null;
      clearTimeout(frameTimer);
      clearInterval(mover);
      clearTimeout(behaveTimer);
      el.removeEventListener("click", click);
      removeEventListener("resize", onResize);
    };
  }, [ok, CW, CH, W, scale]);

  if (!loaded) return null;
  return (
    <div className="pet" ref={box} title={say || mood?.open ? undefined : t("pet.clickMe")} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)} style={{ width: W, height: Math.round(CH * scale) }}>
      {say && (
        <span ref={sayEl} className={`pet-say${bubble || hover ? " on" : ""}`} role="status">
          {say}
        </span>
      )}
      <i ref={clip} style={{ width: CW, height: CH, transform: `scale(${scale})` }}>
        <img ref={spr} src={loaded.src} alt="" draggable={false} />
      </i>
    </div>
  );
}

/** The line in the page's language, its primary tag, English, or the first one given. */
function pickLine(say: Record<string, string>, lang: string): string {
  const primary = (tag: string) => tag.split("-")[0];
  return say[lang] ?? Object.entries(say).find(([tag]) => primary(tag) === primary(lang))?.[1] ?? say.en ?? Object.values(say)[0] ?? "";
}
