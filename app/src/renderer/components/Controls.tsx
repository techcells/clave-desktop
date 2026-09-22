import type {ReactNode} from "react";
import {useCallback, useId, useRef, useState} from "react";

export type ButtonTone = "line" | "ink" | "quiet" | "oxide" | "equal";

/**
 * A ref that is both what a JSX `ref` prop wants (a function called with the element as it mounts
 * and unmounts) and what imperative code wants back (a `.current` to read later) — `useHeading`
 * below needs the former to know exactly when a NEW heading element appears, while Review also needs
 * the latter to send focus back to the heading once the list it is reviewing has emptied.
 */
export interface HeadingRef {
  (node: HTMLHeadingElement | null): void;
  readonly current: HTMLHeadingElement | null;
}

/**
 * The screen's heading, focused once for every new heading ELEMENT that mounts. A window that swaps
 * its whole content without moving focus leaves a keyboard or screen-reader user on a control that no
 * longer exists — focus falls back to the document, so the next Tab starts from the top of the page
 * and nothing is announced. `tabIndex={-1}` on the heading makes it focusable without putting it in
 * the tab order.
 *
 * This is a ref CALLBACK rather than an effect keyed to the component's own mount, because an effect
 * with `[]` deps fires once for the component INSTANCE and never again — which goes quiet the moment
 * a screen's tree changes shape enough for React to discard the old heading DOM node and create a new
 * one at the same JSX position without the component itself remounting. (That is exactly what used to
 * strand focus on Review: the loading and loaded branches wrapped the same `<h1>` in different parent
 * elements, so the heading this hook had focused was gone by the time the list arrived, and nothing
 * ever focused its replacement.) A ref callback is told about that regardless: it fires exactly when
 * the underlying DOM node is created or destroyed. `lastFocused` then makes sure a node that PERSISTS
 * across ordinary re-renders is never focused a second time, and the active-element check makes sure
 * a heading that does get freshly mounted never yanks focus out from under someone who is mid-keystroke
 * in a field elsewhere on the same screen.
 */
export function useHeading(): HeadingRef {
  const lastFocused = useRef<HTMLHeadingElement | null>(null);
  const handle = useRef<HeadingRef | null>(null);
  if (handle.current === null) {
    const ref = ((node: HTMLHeadingElement | null) => {
      ref.current = node;
      if (node === null || node === lastFocused.current) return;
      lastFocused.current = node;
      const active = document.activeElement;
      const typing = active !== null && (active.tagName === "INPUT" || active.tagName === "TEXTAREA" || active.tagName === "SELECT");
      if (!typing) node.focus();
    }) as HeadingRef & {current: HTMLHeadingElement | null};
    ref.current = null;
    handle.current = ref;
  }
  return handle.current;
}

/**
 * The one thing every control here needs: while the promise it started is unsettled it refuses a
 * second press and says so (`aria-busy`, and a running hairline in CSS — nothing moves, nothing is
 * relabelled, so the layout never jumps). A rejected promise clears the state too, so a call that
 * failed can be made again.
 */
export function useAction(): [boolean, (start: () => void | Promise<unknown>) => void] {
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  const run = useCallback((start: () => void | Promise<unknown>) => {
    if (running.current) return;
    const started = start();
    if (!(started instanceof Promise)) return;
    running.current = true;
    setBusy(true);
    const done = () => { running.current = false; setBusy(false); };
    void started.then(done, done);
  }, []);
  return [busy, run];
}

/**
 * Every button that acts on its own click.
 *
 * `busy` is for a button that does NOT own its action: two buttons that answer the same row (Approve
 * and Reject) share one `useAction`, so that pressing either one disables BOTH — a row must not be
 * able to have an approve and a reject in flight at the same time. When `press` hands the work to a
 * shared `run` it returns nothing, so the button's own `useAction` stays idle and `busy` is the only
 * thing speaking.
 */
export function Button({label, press, tone = "line", disabled, describedBy, ariaLabel, busy, hold}: {
  label: string;
  press: () => void | Promise<unknown>;
  tone?: ButtonTone;
  disabled?: boolean;
  describedBy?: string;
  ariaLabel?: string;
  busy?: boolean;
  /** The element itself, for the one screen that has to move focus to a particular button. */
  hold?: (button: HTMLButtonElement | null) => void;
}): ReactNode {
  const [own, run] = useAction();
  const working = own || busy === true;
  return (
    <button
      type="button"
      ref={hold}
      className={`btn btn-${tone}`}
      onClick={() => run(press)}
      disabled={disabled === true || working}
      aria-busy={working || undefined}
      aria-describedby={describedBy}
      aria-label={ariaLabel}
    >
      {label}
    </button>
  );
}

/**
 * A form's own submit button, so Return in a field does exactly what pressing it does. The action
 * belongs to the form's `onSubmit` (one place, one call); this only reports the form's busy state.
 */
export function Submit({label, busy, tone = "line", disabled}: {label: string; busy: boolean; tone?: ButtonTone; disabled?: boolean}): ReactNode {
  return (
    <button type="submit" className={`btn btn-${tone}`} disabled={disabled === true || busy} aria-busy={busy || undefined}>
      {label}
    </button>
  );
}

/** The on/off switch. A real `role="switch"`, so the keyboard and a screen reader both get it. */
export function Switch({on, label, state, press, disabled}: {
  on: boolean;
  label: string;
  state: string;
  press: () => void | Promise<unknown>;
  disabled?: boolean;
}): ReactNode {
  const [busy, run] = useAction();
  return (
    <div className="switchbar">
      <button
        type="button"
        role="switch"
        className="switch"
        aria-checked={on}
        aria-label={label}
        aria-busy={busy || undefined}
        disabled={disabled === true || busy}
        onClick={() => run(press)}
      />
      <span className="switch-state">{state}</span>
    </div>
  );
}

/** A download's progress. The percentage is the machine's voice, so it is set in the monospace. */
export function Meter({label, percent}: {label: string; percent: number}): ReactNode {
  return (
    <div className="meter">
      <div className="meter-track" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
        <div className="meter-fill" style={{width: `${percent}%`}} />
      </div>
      <span className="meter-value" aria-hidden="true">{percent}%</span>
    </div>
  );
}

/** A labelled field with its own validation message, shown next to the field it belongs to. */
export function Field({label, problem, children}: {
  label: string;
  problem?: string | null;
  children: (id: string, describedBy: string | undefined) => ReactNode;
}): ReactNode {
  const id = useId();
  const problemId = `${id}-problem`;
  return (
    <div className="field">
      <label className="label" htmlFor={id}>{label}</label>
      {children(id, problem == null ? undefined : problemId)}
      {problem == null ? null : <p className="problem" id={problemId}>{problem}</p>}
    </div>
  );
}
