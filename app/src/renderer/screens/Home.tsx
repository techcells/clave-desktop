import type {ReactNode} from "react";
import {useState} from "react";
import type {Blocker} from "../../shared/ipc";
import {clave} from "../bridge";
import {Button, Switch, useHeading} from "../components/Controls";
import {blockerCopy, checkingPermissionLine, COPY} from "../copy";
import {fixAction, statusSignature} from "../model/controls";
import {firstBlocker, nothingReadLine} from "../model/views";
import type {Shell} from "../shell";

const clock = new Intl.DateTimeFormat(undefined, {hour: "2-digit", minute: "2-digit"});

/** What `setCapture` refused with, and the status it was refused against. */
interface Refusal { at: string; blocker: Blocker | null }

/**
 * Home: the switch, the pause, and — when the engine says capture cannot run — exactly ONE sentence
 * and ONE button, both taken from `BLOCKERS` and matched to the blocker by `fixAction`. There is no
 * list of problems and no second suggestion: the first blocker in the engine's order is the one
 * thing standing in the way, so it is the only thing offered.
 */
export function Home({shell}: {shell: Shell}): ReactNode {
  const {status} = shell;
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const heading = useHeading();
  const on = status.capture === "on";

  /**
   * A refusal is only worth reading while the status it was refused against still holds. The
   * signature is what the status SAYS, not the object a re-read happened to build, so the notice
   * survives the re-read below (which usually answers the very same thing) and disappears the
   * moment the engine's answer actually changes — by which point the fresh status says it better.
   */
  const signature = statusSignature(status);
  const live = refusal !== null && refusal.at === signature ? refusal : null;
  // One blocker, never two: what `setCapture` just refused with, else the engine's first.
  const blocker = live?.blocker ?? firstBlocker(status);

  /**
   * `setCapture` answers `{ok: false}` with the blockers that stopped it — and, for one turn right
   * after a sign-in, with an EMPTY list, because the engine has not finished catching up. An empty
   * list is therefore "ask me again in a moment", not "no reason": either way the honest move is to
   * re-read the status, which is what fills in the sentence below on the next render.
   */
  const flip = async () => {
    setRefusal(null);
    const answer = await clave.setCapture(!on);
    if (!answer.ok) setRefusal({at: signature, blocker: answer.blockers[0] ?? null});
    shell.askStatus();
  };

  return (
    <div className="enter">
      {/* "Home" is already on screen twice over — the spine's stamped name and the active tab — so
          the heading exists for focus and a screen reader only, not to say it a third time in ink. */}
      <h1 className="sr-only" tabIndex={-1} ref={heading}>{COPY.nav.home}</h1>
      <Switch
        on={on}
        label={COPY.home.reading}
        state={on ? COPY.tray.on : COPY.tray.off}
        press={flip}
      />
      {status.capture === "pausedByUser" && status.resumeAt !== null
        ? <p className="note">{COPY.home.pausedUntil(clock.format(new Date(status.resumeAt)))}</p>
        : null}
      {live !== null && live.blocker === null ? <p className="problem">{COPY.home.notReady}</p> : null}
      {on ? <p className="actions"><Button label={COPY.tray.pause} press={() => clave.pauseForAnHour()} /></p> : null}

      {status.extractionPaused === null ? null : (
        <p className="note">{status.extractionPaused === "lowBattery" ? COPY.home.lowBattery : COPY.home.thermal}</p>
      )}

      {/* Reading is on and a long run of cycles read nothing. Not a problem and not a blocker: no
          `.problem` rule down the side, no fix button, nothing switched off — one quiet line, because
          the only thing wrong is that the user cannot tell working silence from broken silence.
          `nothingReadLine` decides whether there is anything to say at all.

          The paragraph is ALWAYS in the page, empty when there is nothing to say, which is how
          Review's own `aria-live` line is built: a live region has to exist before its text changes,
          or a screen reader announces nothing. An empty paragraph draws no line box, and its margin
          is smaller than the divider's below it, so it costs no space either. */}
      <p className="note" aria-live="polite">{nothingReadLine(status, (ms) => clock.format(new Date(ms))) ?? ""}</p>

      {blocker !== null ? <Fix shell={shell} blocker={blocker} />
        // Only when nothing else stands in the way: a real blocker is the one thing to act on, and
        // the check ends by itself. A quiet line, no button — there is nothing to fix yet.
        : status.checkingPermission ? <div><hr className="divider" /><p className="note">{checkingPermissionLine(shell.appInfo.platform)}</p></div>
        : null}

      <div>
        <hr className="divider" />
        <p className="note">{status.pending > 0 ? COPY.home.pending(status.pending) : COPY.home.nothingPending}</p>
        {status.pending > 0
          ? <p className="actions"><Button label={COPY.nav.review} press={() => shell.go("review")} /></p>
          : null}
      </div>
    </div>
  );
}

/** One sentence, one button, and the button does the thing that actually fixes that blocker. */
function Fix({shell, blocker}: {shell: Shell; blocker: Blocker}): ReactNode {
  const copy = blockerCopy(blocker, shell.appInfo.platform);
  const press = (): void | Promise<unknown> => {
    switch (fixAction(blocker)) {
      case "signIn": return shell.go("onboarding", "signIn");
      case "download": return clave.downloadStart();
      case "selfTest": return clave.selfTest().then(shell.askStatus);
      case "permission": return shell.go("onboarding", "permission");
      case "restart": return clave.restartApp();
      case "settings": return shell.go("settings");
      case "retryModel": return clave.retry("model").then(shell.askStatus);
      case "retryReader": return clave.retry("reader").then(shell.askStatus);
      // Nothing for the user to force: the app is already retrying, so the button asks the window
      // to read the status again — one call, not a `status()` whose answer is then thrown away.
      case "reread": return shell.askStatus();
    }
  };
  return (
    <div>
      <hr className="divider" />
      <p className="problem">{copy.sentence}</p>
      {/* Keyed by the blocker: a different problem is a different button, so it must not inherit the
          previous one's in-flight state and sit there disabled with nothing running. */}
      <p className="actions"><Button key={blocker} tone="ink" label={copy.action} press={press} /></p>
    </div>
  );
}
