import type {ReactNode} from "react";
import {useEffect, useRef, useState} from "react";
import {clave, useAsked} from "../bridge";
import {Unreachable} from "../components/Boundary";
import {Button, useAction, useHeading} from "../components/Controls";
import {COPY} from "../copy";
import {fetchSettled, focusRowAfterDecision} from "../model/focus";
import type {ReviewRow} from "../model/views";
import {reviewRows} from "../model/views";
import type {Shell} from "../shell";

/** The day a statement was captured, and the time something was sent: the locale's own words. */
const day = new Intl.DateTimeFormat(undefined, {weekday: "short", day: "numeric", month: "short"});
const clock = new Intl.DateTimeFormat(undefined, {hour: "2-digit", minute: "2-digit"});

/** At most ten. The tenth row and the first are the same amount of work to answer. */
const MOST = 10;

export type Decision = "approve" | "reject";

/**
 * Review. The one screen where the design has a job beyond looking right: approving must never be
 * easier than reading. So the statement is the largest text on the page, every row is answered on
 * its own, and Approve and Reject are the same button drawn twice — same box, same weight, same
 * type, neither pre-selected, neither tinted until the pointer or the keyboard is already on it.
 * There is no "approve all", no swipe, no default, and no way to edit a statement: the only two
 * things a user can do to a statement are the two things the engine understands.
 *
 * What it does with the engine's ANSWER matters as much. A `false` is not "that statement is gone":
 * the engine does not say why, and it can equally mean a decision already in flight or a disk that
 * refused the outbox. So the honest move is to re-read the list and say only that — `notSaved`.
 * The list is also re-read whenever the pending COUNT in the status changes, so a statement that
 * arrived while this screen was open appears without the user going somewhere and coming back.
 */
export function Review({shell}: {shell: Shell}): ReactNode {
  const [view, askReview, refused] = useAsked(clave.review);
  const [notSaved, setNotSaved] = useState(false);
  const [outcome, setOutcome] = useState("");
  const heading = useHeading();
  const approves = useRef(new Map<number, HTMLButtonElement | null>());
  /** How many rows the CURRENT render put on screen, for the focus-move effect below to read after
   * the fact — it runs after render, once the list a decision's fetch settled against is in hand. */
  const rowCount = useRef(0);
  /** The row a decision was just made on, and the fetch (view + refusal) that decision's own re-read
   * was scheduled against — so the move can tell when THAT fetch, and no other, has settled. */
  const moveFocus = useRef<{index: number; scheduledAgainst: {view: unknown; refused: boolean}} | null>(null);
  const pending = shell.status.pending;
  const seenPending = useRef(pending);

  const answer = async (index: number, id: string, decision: Decision) => {
    // A rejected call (main threw) is not distinguishable from a `false`: the engine did not save
    // the decision either way, so both get the same neutral `notSaved` and the same re-read.
    let ok: boolean;
    try {
      ok = decision === "approve" ? await clave.approve(id) : await clave.reject(id);
    } catch {
      ok = false;
    }
    setNotSaved(!ok);
    setOutcome(!ok ? "" : decision === "approve" ? COPY.review.approved : COPY.review.rejected);
    moveFocus.current = {index, scheduledAgainst: {view, refused}};
    askReview();
    shell.askStatus();
  };

  // A statement that arrived (or left) while this screen was open. The count comes from the pushed
  // status, so this is the one thing that re-reads the list without the user asking.
  useEffect(() => {
    if (seenPending.current === pending) return;
    seenPending.current = pending;
    askReview();
  }, [pending, askReview]);

  /**
   * After a decision, focus the Approve button of the row that now stands where the answered one
   * did — the NEXT statement, which is what a keyboard user wants to answer — or the heading when
   * the list has emptied. It waits for the ONE fetch that decision scheduled to settle, and drops the
   * move the moment it does, whether that fetch succeeded or failed: a failed re-read has nothing to
   * move to (the screen shows `Unreachable` instead of the list below), and — critically — leaving
   * the move pending on a failure used to mean a LATER, unrelated successful re-read would apply it
   * and yank focus from wherever the user had since moved on to. `moveFocus` is only ever set by a
   * decision, so an ordinary re-read (a status tick, a new statement) moves nothing.
   */
  useEffect(() => {
    const want = moveFocus.current;
    if (want === null || !fetchSettled(want.scheduledAgainst, {view, refused})) return;
    moveFocus.current = null;
    if (refused) return;
    const target = focusRowAfterDecision(want.index, rowCount.current);
    const next = target === null ? null : approves.current.get(target) ?? null;
    if (next !== null) next.focus(); else heading.current?.focus();
  }, [view, refused, heading]);

  const rows = view === null ? [] : reviewRows(view, (at) => day.format(new Date(at))).slice(0, MOST);
  rowCount.current = rows.length;
  approves.current = new Map();

  return (
    <div className="enter">
      <h1 className="title title-ledger" tabIndex={-1} ref={heading}>{COPY.review.title}</h1>

      {refused
        // Whatever the list said before is stale now — an initial load that never answered, or a
        // decision's own re-read that failed — so the honest move is the same either way: no partial
        // or leftover list pretending nothing happened, just the one sentence and Try again.
        ? <Unreachable retry={askReview} />
        : view === null
        ? null
        : (
          <>
            {notSaved ? <p className="problem">{COPY.review.notSaved}</p> : null}
            {/* Rendered whatever happens, and never remounted, so a decision's outcome is announced. */}
            <p className="said" aria-live="polite">{outcome}</p>

            {rows.length === 0
              ? <p className="lede">{COPY.review.empty}</p>
              : (
                <ul className="rows">
                  {rows.map((row, index) => (
                    <Row
                      key={row.id}
                      row={row}
                      answer={(decision) => answer(index, row.id, decision)}
                      hold={(button) => { approves.current.set(index, button); }}
                    />
                  ))}
                </ul>
              )}

            <div>
              <hr className="divider" />
              <p className="label">{COPY.review.waiting(view.waitingUpload.length)}</p>
              {view.waitingUpload.length === 0
                ? <p className="note">{COPY.review.waitingEmpty}</p>
                : (
                  <ul className="log">
                    {view.waitingUpload.map((item) => (
                      <li key={item.clientItemId}>
                        <span className="log-when">{clock.format(new Date(item.createdAt))}</span>
                        <span className="log-what">{item.statement}</span>
                      </li>
                    ))}
                  </ul>
                )}
            </div>

            <div>
              <hr className="divider" />
              <p className="label">{COPY.review.sent}</p>
              {view.sent.length === 0
                ? <p className="note">{COPY.review.sentEmpty}</p>
                : (
                  <ul className="log">
                    {view.sent.map((entry) => (
                      <li key={entry.item.clientItemId}>
                        <span className="log-when">{clock.format(new Date(entry.sentAt))}</span>
                        <span className="log-what">{entry.item.statement}</span>
                      </li>
                    ))}
                  </ul>
                )}
            </div>
          </>
        )}
    </div>
  );
}

/**
 * One statement, one decision. The row holds ONE action state and both buttons read it, so while
 * either decision is in flight both are disabled and both say `aria-busy` — a row can never have an
 * approve and a reject on the way at the same time. (Main refuses the second one anyway; this is so
 * the window never asks.)
 */
function Row({row, answer, hold}: {
  row: ReviewRow;
  answer: (decision: Decision) => Promise<void>;
  hold: (button: HTMLButtonElement | null) => void;
}): ReactNode {
  const [busy, run] = useAction();
  return (
    <li className="row">
      <p className="row-head">
        <span className="row-target">{row.target}</span>
        <span className="row-day">{row.day}</span>
      </p>
      <p className="statement">{row.statement}</p>
      <p className="meta">{row.kind === "skill" ? COPY.review.skill : COPY.review.competency}</p>
      <div className="decide">
        <Button tone="equal" busy={busy} hold={hold} label={COPY.review.approve} ariaLabel={COPY.review.approveThis(row.statement)} press={() => run(() => answer("approve"))} />
        <Button tone="equal" busy={busy} label={COPY.review.reject} ariaLabel={COPY.review.rejectThis(row.statement)} press={() => run(() => answer("reject"))} />
      </div>
    </li>
  );
}
