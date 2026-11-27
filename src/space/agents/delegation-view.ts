/**
 * A delegation as the routes, the run event and the panel see it (docs/orders.md#delegation). Pure:
 * the web page imports it.
 *
 * The run event `{"type":"delegation","delegation":<DelegationView>}` is added to the delegator's
 * running turn whenever a delegation of its session starts or changes; the chat view draws it as
 * one step (keyed by `id`) that the next event of the same id replaces.
 */

export const DELEGATION_STATES = ["running", "waiting", "done", "error", "stopped", "timeout", "interrupted"] as const;
export type DelegationState = (typeof DELEGATION_STATES)[number];
export const ENDED_STATES: readonly DelegationState[] = ["done", "error", "stopped", "timeout", "interrupted"];

export const NOTE_KINDS = ["brief", "say", "stop", "result"] as const;
export type NoteKind = (typeof NOTE_KINDS)[number];

export type DelegationNoteView = {
  seq: number;
  at: string;
  kind: NoteKind;
  text: string;
  /** `say`: the runtime took the message into the running turn. */
  taken?: boolean;
  /** `say`: when the runtime reported the agent read it (the run's `steer` event). */
  readAt?: string | null;
  /** `say` not taken: why (`ended`, `unsupported`). `stop`: who stopped it (`delegator`, `person`). `result`: how it reached the delegator. */
  reason?: string;
};

export type DelegationView = {
  id: number;
  label: string;
  from: { agent: string; session: string | null };
  to: { agent: string; role: string; title: string; machine: string; session: string | null; runId: string | null };
  state: DelegationState;
  /** The member's permission when it started; `full` is marked wherever it shows. */
  permission: "ask" | "edit" | "full";
  orderId: number | null;
  /** The delegation it continued (same delegate session), if any. */
  continued: number | null;
  createdAt: string;
  endedAt: string | null;
  /** The brief, the added messages, the stop and the result, in order; never rewritten. */
  notes: DelegationNoteView[];
  /** How the result reached the delegator: added to its running turn, a new turn, or held (the limit of result-triggered turns). */
  delivered: "steered" | "turn" | "held" | null;
  /** What the delegate waits on now (approvals and questions), one line each. */
  asking: string[];
};

/** The label a delegation is spoken of by: "Delegation #3". */
export const delegationLabel = (id: number) => `Delegation #${id}`;

/** The line a delivered result starts with, so a transcript can show it as the delegation's result. */
export const resultHeader = (id: number, role: string, state: DelegationState) => `〔${delegationLabel(id)} · ${role} · ${state}〕`;

/** The delegation a delivered result is about, from its first line; undefined for any other message. */
export function parseResultHeader(text: string): { id: number; role: string; state: string } | undefined {
  const m = /^〔Delegation #(\d+) · ([a-z][a-z0-9-]*) · ([a-z]+)〕/.exec(text.trimStart());
  return m ? { id: Number(m[1]), role: m[2]!, state: m[3]! } : undefined;
}

/** The delegation a `space delegate start` call reported in its output ("Delegation #3 started …"). */
export function startedId(output: string): number | undefined {
  const m = /Delegation #(\d+) started/.exec(output);
  return m ? Number(m[1]) : undefined;
}
