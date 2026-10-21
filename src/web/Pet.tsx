import { useEffect, useRef, useState } from "react";
import { useLang } from "./i18n.ts";

// Desk pet: a sprite sheet the panel walks along the bottom edge. Two kinds of sheet:
// - the Codex format from petdex.dev (8 columns; v1 9 rows and v2 11 rows mean the same, cells 12:13).
//   The bundled default is a capybara at /pet.webp, stored at half size; any other petdex sheet can be
//   shown by name (see petdex.ts). These are loaded without a Referer, which petdex's hotlink
//   protection insists on.
// - an app's pet (docs/app-spec.md#pets): its own grid and animations, its sheet proxied by ai-space,
//   and a mood the app answers: which animation it rests in, whether it roams, a line to say.
// The sheet is an <img> moved inside a clipping box rather than a CSS background: an image needs no CORS.
export const DEFAULT_SHEET = "/pet.webp";

export type PetAnimation = { row: number; frames: number; ms: number };

/** A desk pet declared by an app, as GET /api/pets lists it. */
export type AppPetInfo = {
  /** `<app>/<name>`. */
  id: string;
  app: string;
  name: string;
  title: string;
  i18n?: Record<string, { title?: string }>;
  sheet: string;
  columns: number;
  rows: number;
  width: number;
  pixelated: boolean;
  animations: Record<string, PetAnimation>;
  rest: string;
  hasMood: boolean;
  refreshMs: number;
};

export type PetMood = { animation: string; move: "roam" | "stay"; say?: Record<string, string>; link?: string };

/** How to draw and move one sheet. `rows` undefined = derived from the image (Codex cells are 12:13). */
type Sprite = {
  src: string;
  columns: number;
  rows?: number;
  width: number;
  pixelated?: boolean;
  anims: Record<string, PetAnimation>;
  /** Walking right and left; without `left` the right one is mirrored, and so is the rest after it. */
  right: string;
  left?: string;
  /** Rest animations to pick from when there is no mood, with their weights. */
  rests: [string, number][];
  /** Played once on a click when the mood has no link. */
  click?: string;
};

const CODEX: Omit<Sprite, "src"> = {
  columns: 8,
  width: 70,
  anims: {
    idle: { row: 0, frames: 6, ms: 1100 },
    right: { row: 1, frames: 8, ms: 1060 },
    left: { row: 2, frames: 8, ms: 1060 },
    wave: { row: 3, frames: 4, ms: 700 },
    jump: { row: 4, frames: 5, ms: 840 },
    wait: { row: 6, frames: 6, ms: 1010 },
  },
  right: "right",
  left: "left",
  rests: [["idle", 0.55], ["wait", 0.27], ["wave", 0.18]],
  click: "jump",
};
const SPEED = 55; // px/s

type Cell = { w: number; h: number };

/**
 * A petdex or bundled pet. `sheet` is the sprite sheet URL; when it fails to load the bundled default is
 * shown instead and `onError` fires once so the owner can re-resolve or forget the choice.
 */
export default function Pet({ sheet = DEFAULT_SHEET, onError }: { sheet?: string; onError?: (sheet: string) => void }) {
  return <SpritePet sprite={{ ...CODEX, src: sheet }} fallback={DEFAULT_SHEET} onError={onError} />;
}

/** An app's pet: its mood is read through ai-space on the pet's refresh while the page is visible. */
export function AppPet({ pet }: { pet: AppPetInfo }) {
  const [mood, setMood] = useState<PetMood | null>(null);
  useEffect(() => {
    setMood(null);
    if (!pet.hasMood) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = () => {
      clearTimeout(timer);
      if (document.visibilityState === "visible")
        fetch(`/api/pets/${encodeURIComponent(pet.app)}/${encodeURIComponent(pet.name)}/mood`)
          .then((r) => r.json())
          .then((j: { ok?: boolean } & PetMood) => {
            // A mood that cannot be read lets the pet rest; it is never guessed.
            if (live) setMood(j.ok ? { animation: j.animation, move: j.move, say: j.say, link: j.link } : null);
          })
          .catch(() => live && setMood(null));
      timer = setTimeout(read, pet.refreshMs);
    };
    const onVisible = () => document.visibilityState === "visible" && read();
    read();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      live = false;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [pet.app, pet.name, pet.hasMood, pet.refreshMs]);
  const sprite: Sprite = {
    src: pet.sheet,
    columns: pet.columns,
    rows: pet.rows,
    width: pet.width,
    pixelated: pet.pixelated,
    anims: pet.animations,
    right: "walk",
    rests: [[pet.rest, 1]],
    ...(pet.animations.jump ? { click: "jump" } : {}),
  };
  return <SpritePet sprite={sprite} mood={mood} />;
}

function SpritePet({ sprite, mood = null, fallback, onError }: { sprite: Sprite; mood?: PetMood | null; fallback?: string; onError?: (sheet: string) => void }) {
  const { t, lang } = useLang();
  const [loaded, setLoaded] = useState<{ src: string; cell: Cell } | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const clip = useRef<HTMLElement>(null);
  const spr = useRef<HTMLImageElement>(null);
  const fail = useRef(onError);
  fail.current = onError;
  // The walker reads these through refs, so a new mood or a new sprite object never resets its position.
  const spriteRef = useRef(sprite);
  spriteRef.current = sprite;
  const moodRef = useRef(mood);
  const onMood = useRef<(() => void) | null>(null);
  const moodKey = mood ? `${mood.animation}/${mood.move}` : "";
  useEffect(() => {
    moodRef.current = mood;
  });
  useEffect(() => {
    onMood.current?.();
  }, [moodKey]);

  // Load the sheet off-screen to learn its cell size; the previous pet stays until the new one is ready.
  const { src, columns, rows } = sprite;
  useEffect(() => {
    let live = true;
    const load = (url: string, isFallback: boolean) => {
      const img = new Image();
      img.referrerPolicy = "no-referrer";
      img.onload = () => {
        if (!live) return;
        const w = img.naturalWidth / columns;
        const n = rows ?? Math.max(1, Math.round(img.naturalHeight / ((w * 13) / 12)));
        setLoaded({ src: url, cell: { w, h: img.naturalHeight / n } });
      };
      img.onerror = () => {
        if (!live) return;
        if (isFallback || !fallback) return setLoaded(null);
        fail.current?.(url);
        load(fallback, true);
      };
      img.src = url;
    };
    load(src, src === fallback);
    return () => {
      live = false;
    };
  }, [src, columns, rows, fallback]);

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
    let frameTimer: ReturnType<typeof setInterval> | undefined;
    let behaveTimer: ReturnType<typeof setTimeout> | undefined;
    const walking = () => state === sp().right || (!!sp().left && state === sp().left);

    const draw = () => {
      if (!spr.current || !box.current || !clip.current) return;
      const a = sp().anims[state];
      if (!a) return;
      spr.current.style.transform = `translate(${-frame * CW}px, ${-a.row * CH}px)`;
      const mirror = !sp().left && facing === "left";
      clip.current.style.transform = mirror ? `translateX(${W}px) scale(${-scale}, ${scale})` : `scale(${scale})`;
      box.current.style.transform = `translate3d(${x}px,0,0)`;
    };
    const setState = (s: string) => {
      const a = sp().anims[s];
      if (!a) return;
      state = s;
      frame = 0;
      clearInterval(frameTimer);
      frameTimer = setInterval(() => {
        frame += 1;
        if (frame >= a.frames) {
          frame = 0;
          if (oneShot) {
            const done = oneShot;
            oneShot = null;
            done();
          }
        }
        draw();
      }, a.ms / a.frames);
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
    // Walk somewhere, or rest; a mood that says "stay" keeps the pet where it is, in its animation.
    const behave = () => {
      clearTimeout(behaveTimer);
      oneShot = null;
      const m = moodRef.current;
      if (m?.move === "stay") return setState(pickRest());
      const calm = !!m; // a pet with a mood rests longer between walks
      if (Math.random() < (calm ? 0.3 : 0.45)) {
        target = Math.random() * Math.max(0, innerWidth - W);
        facing = target > x ? "right" : "left";
        setState(facing === "right" || !sp().left ? sp().right : sp().left!);
      } else {
        setState(pickRest());
        behaveTimer = setTimeout(behave, calm ? 6000 + Math.random() * 10_000 : 1800 + Math.random() * 3500);
      }
    };
    onMood.current = behave;
    const mover = setInterval(() => {
      if (!walking()) return;
      x += (SPEED / 25) * (facing === "right" ? 1 : -1);
      if ((facing === "right" && x >= target) || (facing === "left" && x <= target)) {
        x = target;
        behave();
      }
      draw();
    }, 40);
    // Click: follow the mood's link, or play the click animation once.
    const el = box.current;
    const click = () => {
      const link = moodRef.current?.link;
      if (link) return void window.open(link, "_blank", "noopener");
      const c = sp().click;
      if (c && state !== c && sp().anims[c]) {
        oneShot = behave;
        setState(c);
      }
    };
    el.addEventListener("click", click);

    behave();
    return () => {
      onMood.current = null;
      clearInterval(frameTimer);
      clearInterval(mover);
      clearTimeout(behaveTimer);
      el.removeEventListener("click", click);
    };
  }, [ok, CW, CH, W, scale]);

  if (!loaded) return null;
  const say = mood?.say ? pickLine(mood.say, lang) : "";
  return (
    <div className="pet" ref={box} title={say || (mood?.link ? "" : t("pet.clickMe"))} style={{ width: W, height: Math.round(CH * scale) }}>
      {say && (
        <span className="pet-say" role="status">
          {say}
        </span>
      )}
      <i ref={clip} style={{ width: CW, height: CH, transform: `scale(${scale})` }}>
        <img ref={spr} src={loaded.src} alt="" referrerPolicy="no-referrer" draggable={false} style={sprite.pixelated ? { imageRendering: "pixelated" } : undefined} />
      </i>
    </div>
  );
}

/** The line in the page's language, its primary tag, English, or the first one given. */
function pickLine(say: Record<string, string>, lang: string): string {
  const primary = (tag: string) => tag.split("-")[0];
  return say[lang] ?? Object.entries(say).find(([tag]) => primary(tag) === primary(lang))?.[1] ?? say.en ?? Object.values(say)[0] ?? "";
}
