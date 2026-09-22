import type {ReactNode} from "react";
import {FLAVOUR} from "../../shared/flavour";
import {COPY} from "../copy";
import type {Screen, Step} from "../model/views";
import {STEPS} from "../model/views";

/** How the one status line reads: a problem, or reading on, or reading off. */
export type Tone = "problem" | "on" | "off";

/**
 * The window itself: spine, masthead, the one live status line, the scrolling sheet, and the tabs.
 * It is rendered ONCE, above the screens, so the `aria-live` line is the same DOM node for the whole
 * life of the page — a live region that is unmounted and remounted with each screen announces
 * nothing at all, which is the usual way this requirement is quietly lost.
 */
export function Frame({spine, tone, announce, tabs, children}: {
  spine: ReactNode;
  tone: Tone;
  announce: string;
  tabs: ReactNode;
  children: ReactNode;
}): ReactNode {
  return (
    <div className="window">
      <div className="spine" aria-hidden="true">{spine}</div>
      <header className="masthead">
        <span className="mark">{COPY.appName}</span>
        {/* The internal flavour says so on every screen: it uploads nothing and is not the release. */}
        {FLAVOUR === "internal" ? <span className="mark mark-flavour">{COPY.settings.internalMark}</span> : null}
      </header>
      <p className={`announce announce-${tone}`} aria-live="polite">{announce}</p>
      <main className="sheet" tabIndex={-1}>{children}</main>
      {tabs}
    </div>
  );
}

/** The binding: one tick per step of the spec's onboarding, the finished ones inked. */
export function StepSpine({step}: {step: Step}): ReactNode {
  const here = STEPS.indexOf(step);
  return (
    <>
      <span className="tick-number">{here + 1}</span>
      <span className="ticks">
        {STEPS.map((name, index) => (
          <span key={name} className={`tick${index === here ? " tick-here" : index < here ? " tick-done" : ""}`} />
        ))}
      </span>
    </>
  );
}

/** Afterwards: the screen's name stamped up the edge of the page. */
export const NameSpine = ({name}: {name: string}): ReactNode => <span className="spine-name">{name}</span>;

export function Tabs({here, pending, go}: {here: Screen; pending: number; go: (screen: Screen) => void}): ReactNode {
  const tab = (screen: Screen, label: ReactNode) => (
    <button type="button" className={`tab${here === screen ? " tab-here" : ""}`} aria-current={here === screen ? "page" : undefined} onClick={() => go(screen)}>
      {label}
    </button>
  );
  return (
    <nav className="tabs" aria-label={COPY.nav.label}>
      {tab("home", COPY.nav.home)}
      {tab("review", pending > 0 ? COPY.tray.review(pending) : COPY.nav.review)}
      {tab("settings", COPY.nav.settings)}
    </nav>
  );
}
