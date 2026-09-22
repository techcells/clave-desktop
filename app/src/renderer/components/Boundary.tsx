import type {ErrorInfo, ReactNode} from "react";
import {Component} from "react";
import {COPY} from "../copy";
import {Button} from "./Controls";

/**
 * What the window shows when main will not answer: one sentence, one button. Used by App before
 * anything at all has arrived, by Review when the list itself was refused, and by the boundary
 * below when a component threw — the causes differ, the user's move does not, so the words do not
 * differ either.
 */
export function Unreachable({retry}: {retry: () => void}): ReactNode {
  return (
    <div className="enter">
      <p className="problem">{COPY.common.noAnswer}</p>
      <p className="actions"><Button tone="ink" label={COPY.common.tryAgain} press={retry} /></p>
    </div>
  );
}

interface BoundaryState { broken: boolean }

/**
 * The last line against a blank window. A component that throws while rendering takes React's whole
 * tree down with it and leaves the user a blank rectangle with nothing on it and nothing to press —
 * the one failure mode a tray app cannot explain, because there is no console for the user to look
 * at and no crash report this app would ever send anywhere.
 *
 * Nothing is logged and nothing is reported: there is no remote to report to, and WHAT-LEAVES.md
 * says so. This is a class because an error boundary can only be one — `getDerivedStateFromError`
 * has no hook.
 */
export class Boundary extends Component<{children: ReactNode}, BoundaryState> {
  override state: BoundaryState = {broken: false};

  static getDerivedStateFromError(): BoundaryState {
    return {broken: true};
  }

  override componentDidCatch(_error: unknown, _info: ErrorInfo): void {
    // Deliberately empty: see the note above. React has already printed it to the dev console.
  }

  override render(): ReactNode {
    if (!this.state.broken) return this.props.children;
    // The frame is written out here rather than reused from Frame.tsx: whatever threw may well be
    // Frame, and a boundary that renders the thing that broke is not a boundary.
    return (
      <div className="window">
        <div className="spine" aria-hidden="true" />
        <header className="masthead"><span className="mark">{COPY.appName}</span></header>
        <p className="announce announce-problem" aria-live="polite" />
        <main className="sheet">
          <Unreachable retry={() => this.setState({broken: false})} />
        </main>
      </div>
    );
  }
}
