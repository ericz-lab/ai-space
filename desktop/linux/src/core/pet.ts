import type { Rect, Size } from "./floating-ball.ts";

/**
 * The desk pet (docs/app-spec.md#space-mood): the web panel's Claude, drawn from the same sheet
 * (src/web/public/pet-claude.webp, made by src/web/pets/claude.py) with the same animations and the
 * same table for the Space's mood as src/web/Pet.tsx. These are its rules without GTK, ported from
 * the Mac's `PetRules.swift` (desktop/macos/AISpace/Services/), so `bun test` runs them; pet.test.ts
 * checks this table against the web's. Coordinates are the desktop's, y pointing down.
 *
 * The pet walks in the main window (app/pet.ts) or on the desktop over every app: like the floating
 * ball, a process of its own (`src/pet/pet.ts`, GTK 3 on X11, through XWayland on a Wayland
 * desktop), since a Wayland window can neither stay above the others nor place itself.
 */

/** The Space's mood as `GET /api/pets/mood` answers it. Every field but `state` may be missing. */
export type SpaceMood = {
  ok?: boolean;
  state: string;
  reason?: string;
  move?: string;
  say?: { en: string; zh?: string };
  open?: PetOpen;
};

/** What a click opens: `chat` with the agent's id (`<app>/<agent>`), or `inbox`. */
export type PetOpen = { kind: "chat"; agent: string } | { kind: "inbox" };

const str = (v: unknown): v is string => typeof v === "string";

function decodeOpen(v: unknown): PetOpen | undefined {
  if (typeof v !== "object" || v === null) return undefined;
  const o = v as Record<string, unknown>;
  if (o.kind === "inbox") return { kind: "inbox" };
  if (o.kind === "chat" && str(o.agent) && o.agent) return { kind: "chat", agent: o.agent };
  return undefined;
}

/** The route's answer, checked; anything else (an older Space, an error page) is no mood. */
export function decodeMood(raw: unknown): SpaceMood | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const m = raw as Record<string, unknown>;
  if (!str(m.state)) return undefined;
  const say = m.say as Record<string, unknown> | undefined;
  const open = decodeOpen(m.open);
  return {
    ...(typeof m.ok === "boolean" ? { ok: m.ok } : {}),
    state: m.state,
    ...(str(m.reason) ? { reason: m.reason } : {}),
    ...(str(m.move) ? { move: m.move } : {}),
    ...(say && str(say.en) ? { say: { en: say.en, ...(str(say.zh) ? { zh: say.zh } : {}) } } : {}),
    ...(open ? { open } : {}),
  };
}

/** The line in the language on show: Chinese for `zh`, English otherwise; undefined when empty. */
export function sayText(say: SpaceMood["say"], lang: string): string | undefined {
  if (!say) return undefined;
  const t = lang === "zh" ? (say.zh ?? say.en) : say.en;
  return t || undefined;
}

/** One row of the sheet: `frames` cells from the left, played over `ms`; with `pause`, the first cell is held that much longer after each loop. */
export type PetAnimation = { row: number; frames: number; ms: number; pause?: number };

/** How long one cell of `a` shows, in seconds. */
export const stepOf = (a: PetAnimation) => a.ms / Math.max(a.frames, 1) / 1000;

export type PetSprite = {
  /** The sheet's file name, beside the app (build.ts copies it). */
  file: string;
  columns: number;
  rows: number;
  /** Width in pixels the scuttle is drawn for; the size scales it, and the speed with it. */
  width: number;
  /** Pixels per second at `width`. */
  speed: number;
  anims: Record<string, PetAnimation>;
  walk: string;
  /** Rest animations to pick from when there is no mood, with their weights. */
  rests: [string, number][];
  /** Played once on a click when the mood opens nothing. */
  click: string;
  /** The animation the pet rests in by state (`<state>/stay` while it waits in its corner); a state not listed rests as without a mood. */
  moodRests: Record<string, string>;
  /** Played once as a state begins. */
  moodOnce: Record<string, string>;
};

/** Claude, as `CLAUDE` in src/web/Pet.tsx (pet.test.ts compares the two). */
export const CLAUDE: PetSprite = {
  file: "pet-claude.webp",
  columns: 12,
  rows: 5,
  width: 80,
  speed: 55,
  anims: {
    walk: { row: 0, frames: 8, ms: 320 },
    sleep: { row: 1, frames: 12, ms: 3600 },
    look: { row: 2, frames: 12, ms: 2880 },
    hop: { row: 3, frames: 12, ms: 900, pause: 1400 },
    jump: { row: 4, frames: 12, ms: 720 },
  },
  walk: "walk",
  rests: [["look", 0.5], ["sleep", 0.38], ["hop", 0.12]],
  click: "jump",
  moodRests: { working: "look", waiting: "look", "waiting/stay": "hop", error: "look", done: "look", sleep: "sleep" },
  moodOnce: { done: "jump" },
};

/** Where the pet walks: along the bottom of the main window, or along the bottom of the screen over every app. */
export type PetPlace = "window" | "desktop";
export const PET_SIZES = { small: 60, medium: 80, large: 110 } as const;
export type PetSize = keyof typeof PET_SIZES;
export const isPetSize = (v: unknown): v is PetSize => typeof v === "string" && v in PET_SIZES;

/** A mood in the sprite's terms: what it rests in, whether it waits in its corner, what it plays once as the mood begins, what it says and what a click opens. */
export type PetMood = { rest: string; stay: boolean; once?: string; say?: SpaceMood["say"]; open?: PetOpen };

/** Undefined, rest as without a mood, for a state the sprite does not list (`idle`, a newer one). */
export function shownMood(mood: SpaceMood | undefined, sprite: PetSprite = CLAUDE): PetMood | undefined {
  if (!mood || mood.ok === false) return undefined;
  const stay = mood.move === "stay";
  const rest = (stay ? sprite.moodRests[`${mood.state}/stay`] : undefined) ?? sprite.moodRests[mood.state];
  if (!rest || !sprite.anims[rest]) return undefined;
  const once = sprite.moodOnce[mood.state];
  return { rest, stay, ...(once ? { once } : {}), ...(mood.say ? { say: mood.say } : {}), ...(mood.open ? { open: mood.open } : {}) };
}

/** What tells one mood from the next: a new one starts the pet's behaviour over. */
export const moodKey = (m: PetMood | undefined) => (m ? `${m.rest}/${m.stay}/${m.once ?? ""}` : "");

/** Clear of the corner's edge, as the panel's pet waits clear of its dock. */
export const CORNER_GAP = 24;

/**
 * The pet's walk and its frames, as src/web/Pet.tsx moves it: walk to a random spot, rest a while,
 * walk again; a mood that stays sends it to the right-hand corner, where it rests facing into the
 * page. Time is in seconds, place in pixels from the left of the stage. The view calls
 * `advance(now)` when the time it returned comes, so nothing runs between two changes.
 */
export class PetMotion {
  x = 0;
  animation: string;
  frame = 0;
  facingLeft = false;
  mood: PetMood | undefined;
  private target: number | undefined;
  private oneShot = false;
  private nextFrame = 0;
  private nextBehave: number | undefined;
  private lastMove: number;

  constructor(
    readonly sprite: PetSprite,
    public width: number,
    public stage: number,
    now: number,
    private readonly random: () => number = Math.random,
  ) {
    this.animation = sprite.rests[0]?.[0] ?? sprite.walk;
    this.x = random() * Math.max(0, stage - width);
    this.lastMove = now;
    this.behave(now);
  }

  /** Pixels per second at this size, so the feet stay planted at any width. */
  get speed(): number {
    return (this.sprite.speed * this.width) / this.sprite.width;
  }

  get walking(): boolean {
    return this.target !== undefined;
  }

  /** Where a pet that stays waits. */
  get corner(): number {
    return Math.max(0, this.stage - this.width - CORNER_GAP);
  }

  /** The cell on show: its column and row in the sheet. */
  get cell(): { column: number; row: number } {
    return { column: Math.min(this.frame, this.sprite.columns - 1), row: this.sprite.anims[this.animation]?.row ?? 0 };
  }

  /** A new mood: played once if it begins with an animation, else the behaviour starts over. The same mood again changes nothing. */
  setMood(mood: PetMood | undefined, now: number): void {
    const changed = moodKey(mood) !== moodKey(this.mood);
    this.mood = mood;
    if (!changed) return;
    if (!this.playOnce(mood?.once, now)) this.behave(now);
  }

  /** A click that opens nothing: the click animation once. */
  click(now: number): void {
    this.playOnce(this.sprite.click, now);
  }

  /** The stage changed size (a resized window, another screen): the pet stays on it, and one that stays follows its corner. */
  resize(stage: number, now: number, width?: number): void {
    this.stage = stage;
    if (width !== undefined) this.width = width;
    const max = Math.max(0, this.stage - this.width);
    this.x = Math.min(Math.max(0, this.x), max);
    if (this.target !== undefined) this.target = Math.min(Math.max(0, this.target), max);
    if (this.mood?.stay && !this.walking) this.behave(now);
  }

  /** The pet held at `x` (a drag in progress, or the pointer resting on it): it stays there and does nothing else until let go. */
  hold(x: number, now: number): void {
    this.x = Math.min(Math.max(0, x), Math.max(0, this.stage - this.width));
    this.target = undefined;
    this.oneShot = false;
    this.nextBehave = undefined;
    this.lastMove = now;
  }

  /** The pet let go at `x`: it carries on from there. */
  drop(x: number, now: number): void {
    this.x = Math.min(Math.max(0, x), Math.max(0, this.stage - this.width));
    this.target = undefined;
    this.oneShot = false;
    this.lastMove = now;
    this.behave(now);
  }

  /** Everything due by `now`: the walk, the frames, the next behaviour. Returns the seconds until the next change. */
  advance(now: number): number {
    // The walk: at the sprite's speed, the cell changing with it, so the feet do not slide.
    if (this.target !== undefined) {
      const t = this.target;
      const dx = this.speed * Math.max(0, now - this.lastMove);
      if (Math.abs(t - this.x) <= dx) {
        this.x = t;
        this.target = undefined;
        this.behave(now);
      } else this.x += t > this.x ? dx : -dx;
    }
    this.lastMove = now;
    if (this.nextBehave !== undefined && now >= this.nextBehave && !this.walking && !this.oneShot) {
      this.nextBehave = undefined;
      this.behave(now);
    }
    // At most one loop of frames per call: a late call skips cells, it never replays them.
    for (let n = 0; now >= this.nextFrame && n < 64; n++) this.stepFrame(now);
    let next = this.nextFrame - now;
    if (this.nextBehave !== undefined && !this.walking) next = Math.min(next, this.nextBehave - now);
    return Math.max(0.016, next);
  }

  private stepFrame(now: number): void {
    const a = this.sprite.anims[this.animation];
    if (!a) {
      this.nextFrame = now + 1;
      return;
    }
    this.frame++;
    if (this.frame >= a.frames) {
      this.frame = 0;
      if (this.oneShot) {
        this.oneShot = false;
        this.behave(now);
        return;
      }
    }
    this.nextFrame += this.frame === 0 && a.pause ? stepOf(a) + a.pause / 1000 : stepOf(a);
    // A call long after the last one starts the timing again from now.
    if (this.nextFrame < now - 1) this.nextFrame = now + stepOf(a);
  }

  private setAnimation(name: string, now: number): void {
    const a = this.sprite.anims[name];
    if (!a) return;
    this.animation = name;
    this.frame = 0;
    this.nextFrame = now + stepOf(a);
  }

  /** Plays `name` once, then behaves as before; false when the sprite lacks it or plays it already. */
  private playOnce(name: string | undefined, now: number): boolean {
    if (!name || (name === this.animation && this.oneShot) || !this.sprite.anims[name]) return false;
    this.target = undefined;
    this.nextBehave = undefined;
    this.oneShot = true;
    this.setAnimation(name, now);
    return true;
  }

  private walkTo(place: number, now: number): void {
    this.target = place;
    this.facingLeft = place < this.x;
    this.lastMove = now;
    this.nextBehave = undefined;
    this.setAnimation(this.sprite.walk, now);
  }

  private pickRest(): string {
    if (this.mood) return this.mood.rest;
    let r = this.random();
    for (const [name, weight] of this.sprite.rests) {
      r -= weight;
      if (r <= 0) return name;
    }
    return this.sprite.rests[0]?.[0] ?? this.sprite.walk;
  }

  /** Walk somewhere, or rest; a mood that stays sends the pet to its corner and keeps it there. */
  private behave(now: number): void {
    this.oneShot = false;
    this.nextBehave = undefined;
    if (this.mood?.stay) {
      if (Math.abs(this.x - this.corner) > 2) return this.walkTo(this.corner, now);
      this.facingLeft = true;
      this.target = undefined;
      return this.setAnimation(this.pickRest(), now);
    }
    // A pet with a mood rests longer between walks.
    const calm = this.mood !== undefined;
    if (this.random() < (calm ? 0.3 : 0.45)) this.walkTo(this.random() * Math.max(0, this.stage - this.width), now);
    else {
      this.target = undefined;
      this.setAnimation(this.pickRest(), now);
      this.nextBehave = now + (calm ? 6 + this.random() * 10 : 1.8 + this.random() * 3.5);
    }
  }
}

/** The bubble over the pet comes and goes while its line stays: shown at once when the line changes, then 6 seconds shown and 14 hidden; pointing at the pet shows it too. */
export const BUBBLE_SHOWN = 6;
export const BUBBLE_HIDDEN = 14;

export function bubbleVisible(elapsed: number): boolean {
  if (elapsed < 0) return false;
  return elapsed % (BUBBLE_SHOWN + BUBBLE_HIDDEN) < BUBBLE_SHOWN;
}

/** Seconds until the bubble next appears or goes. */
export function bubbleUntilChange(elapsed: number): number {
  const t = Math.max(0, elapsed) % (BUBBLE_SHOWN + BUBBLE_HIDDEN);
  return t < BUBBLE_SHOWN ? BUBBLE_SHOWN - t : BUBBLE_SHOWN + BUBBLE_HIDDEN - t;
}

// On the desktop

/** The desktop pet's window holds its bubble too: this much room above the sprite. */
export const BUBBLE_ROOM = 72;
/** The widest bubble, which opens to one side of the pet. */
export const BUBBLE_WIDTH = 220;

/** The window for a pet `pet` big at `x` on a stage along the bottom of the work area `area`: centred on the pet, room for the bubble on either side, kept on the screen. */
export function deskWindow(x: number, pet: Size, area: Rect): Rect {
  const width = pet.width + 2 * BUBBLE_WIDTH;
  const height = pet.height + BUBBLE_ROOM;
  const left = area.x + x + pet.width / 2 - width / 2;
  const clamped = Math.min(Math.max(left, area.x), area.x + area.width - width);
  return { x: Math.round(clamped), y: Math.round(area.y + area.height - height), width, height };
}

/** The pet's own rectangle inside that window, where clicks land. */
export function deskSprite(x: number, pet: Size, window: Rect, area: Rect): Rect {
  return { x: Math.round(area.x + x - window.x), y: window.height - pet.height, width: pet.width, height: pet.height };
}

/** A remembered place, as a fraction of the stage, so another screen size keeps it. */
export function spotFraction(x: number, stage: number, width: number): number {
  const room = stage - width;
  return room > 0 ? Math.min(Math.max(x / room, 0), 1) : 0;
}

export function spotX(fraction: number, stage: number, width: number): number {
  return Math.max(0, stage - width) * Math.min(Math.max(fraction, 0), 1);
}

/** Which way the bubble opens: towards the middle of the stage, so it never runs off an edge. */
export const opensRight = (x: number, width: number, stage: number) => x + width / 2 < stage / 2;

// The desktop pet's process and the app talk in JSON lines, as the floating ball does.

/** App → pet. */
export type ToPet =
  | { type: "init"; sheet: string; size: number; spot?: number; dark: boolean; labels: { toWindow: string; hide: string; name: string } }
  | { type: "mood"; mood?: PetMood; line?: string }
  | { type: "size"; size: number }
  | { type: "look"; dark: boolean }
  | { type: "quit" };

/** Pet → app. */
export type FromPet =
  | { type: "ready" }
  | { type: "moved"; spot: number }
  | { type: "open"; open: PetOpen; startupId?: string }
  | { type: "menu"; action: "window" | "hide" };

/** A line from the pet's process, checked: anything malformed is dropped. */
export function decodeFromPet(line: string): FromPet | undefined {
  let m: Record<string, unknown>;
  try {
    m = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  if (typeof m !== "object" || m === null) return undefined;
  switch (m.type) {
    case "ready":
      return { type: "ready" };
    case "moved":
      return typeof m.spot === "number" && Number.isFinite(m.spot) ? { type: "moved", spot: Math.min(Math.max(m.spot, 0), 1) } : undefined;
    case "open": {
      const open = decodeOpen(m.open);
      if (!open || !(m.startupId === undefined || str(m.startupId))) return undefined;
      return { type: "open", open, ...(m.startupId ? { startupId: m.startupId as string } : {}) };
    }
    case "menu":
      return m.action === "window" || m.action === "hide" ? { type: "menu", action: m.action } : undefined;
    default:
      return undefined;
  }
}
