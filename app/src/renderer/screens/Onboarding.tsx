import type {ReactNode} from "react";
import {useEffect, useRef, useState} from "react";
import type {Permission, SettingsProblem} from "../../shared/ipc";
import {clave, useDownload} from "../bridge";
import {Unreachable} from "../components/Boundary";
import {Button, Field, Meter, Submit, useAction, useHeading} from "../components/Controls";
import {EntryList} from "../components/EntryList";
import {APP_FILE, BLOCKERS, CLAIMS, COPY, downloadProblem, KNOWN_LIMITS, PERMISSION_STEPS, SETTINGS_PROBLEMS, SIGN_IN_PROBLEMS} from "../copy";
import type {Step} from "../model/views";
import {STEPS, downloadView, gigabytes, isTranslocated, stillWaiting} from "../model/views";
import type {Shell} from "../shell";

/**
 * Onboarding, in the fixed order of spec section 7. The step is NOT chosen here: `onboardingStep`
 * in model/views.ts decides it from the real state, and this renders whichever one it named. The
 * only exception is `forced`, which is a finished user sent back to one step by a home-screen fix
 * button; then there is a way back out and nothing is re-taught.
 *
 * Each step is its own component so that its hooks are unconditional and its draft state is thrown
 * away when the step changes, and each finishes by writing the COUNT of finished steps —
 * `onboardingStep: 1` after the pitch, `5` after "what is never read", `6` after the review time and
 * `7` after the last step has been read, which is what ends onboarding. The machine-checked steps in
 * between write nothing: signing in, downloading and the permission grant are visible in the status,
 * so they need no stored number and survive being undone.
 *
 * Every step focuses its own heading when it appears (`useHeading`): the window replaces its whole
 * content, so leaving focus where it was would strand a keyboard user on a control that is gone.
 */
export function Onboarding({shell, step, forced}: {shell: Shell; step: Step; forced: boolean}): ReactNode {
  return (
    <div className="enter" key={step}>
      <p className="label">{COPY.onboarding.step(STEPS.indexOf(step) + 1, STEPS.length)}</p>
      {step === "pitch" ? <Pitch shell={shell} />
        : step === "signIn" ? <SignIn shell={shell} />
        : step === "model" ? <Model shell={shell} />
        : step === "permission" ? <PermissionStep shell={shell} />
        : step === "neverRead" ? <NeverRead shell={shell} />
        : step === "reviewTime" ? <ReviewTime shell={shell} />
        : <Done shell={shell} />}
      {forced ? <p className="actions"><Button tone="quiet" label={COPY.common.back} press={() => shell.go("home")} /></p> : null}
    </div>
  );
}

/** Step 1. The five claims, verbatim, and the page that repeats them. */
function Pitch({shell}: {shell: Shell}): ReactNode {
  const heading = useHeading();
  return (
    <>
      <h1 className="title" tabIndex={-1} ref={heading}>{COPY.onboarding.pitch}</h1>
      <ol className="claims">{CLAIMS.map((claim) => <li key={claim}>{claim}</li>)}</ol>
      <p className="actions">
        <Button tone="ink" label={COPY.common.continue} press={() => shell.save({onboardingStep: 1})} />
        <Button tone="quiet" label={COPY.common.whatLeaves} press={() => clave.openWhatLeaves()} />
      </p>
    </>
  );
}

/** Step 2. Signing in is machine-checked: a success clears SIGNED_OUT and the step moves itself on. */
function SignIn({shell}: {shell: Shell}): ReactNode {
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [inBrowser, setInBrowser] = useState(false);
  const cancelledByUser = useRef(false);
  const [busy, run] = useAction();
  const heading = useHeading();

  // The browser path is only offered by a build that has one (the real backend); a stand-in build has nothing to send the browser to.
  const browserOffered = shell.appInfo.googleSignIn === true;

  /** Same shape as `submit`: the answer, whatever it is, ends the waiting state and asks main for the status that now stands. */
  const throughBrowser = async () => {
    setInBrowser(true);
    setProblem(null);
    cancelledByUser.current = false;
    try {
      const result = await clave.signInWithGoogle();
      // A wait the user ended themselves is not a failure to report; main answers it with the timeout code.
      const silent = result.ok || (result.code === "OAUTH_TIMEOUT" && cancelledByUser.current);
      setProblem(silent ? null : SIGN_IN_PROBLEMS[result.code]);
      if (!result.ok) heading.current?.focus();
    } finally {
      setInBrowser(false);
      shell.askStatus();
    }
  };
  const cancelBrowser = () => { cancelledByUser.current = true; void clave.cancelGoogleSignIn(); };

  /**
   * The password leaves this component's state as soon as the call has been ANSWERED, whatever the
   * answer was — including a call that threw. It was held until the next successful sign-in before,
   * which meant a refused attempt left the typed password sitting in React state (and in the input)
   * for as long as the window stayed on this step.
   */
  const submit = async () => {
    try {
      const result = await clave.signIn(identifier, password);
      setProblem(result.ok ? null : SIGN_IN_PROBLEMS[result.code]);
    } finally {
      setPassword("");
      shell.askStatus();
    }
  };

  return (
    <>
      <h1 className="title" tabIndex={-1} ref={heading}>{COPY.onboarding.signIn}</h1>
      <form onSubmit={(event) => { event.preventDefault(); run(submit); }}>
        <Field label={COPY.onboarding.identifier}>
          {(id) => <input id={id} className="input" type="text" inputMode="email" autoComplete="username" spellCheck={false} value={identifier} onChange={(e) => setIdentifier(e.target.value)} />}
        </Field>
        <Field label={COPY.onboarding.password} problem={problem}>
          {(id, describedBy) => <input id={id} className="input" type="password" autoComplete="current-password" aria-describedby={describedBy} value={password} onChange={(e) => setPassword(e.target.value)} />}
        </Field>
        <p className="actions"><Submit tone="ink" label={COPY.onboarding.signIn} busy={busy} disabled={inBrowser} /></p>
      </form>
      {browserOffered && !inBrowser && (
        <p className="actions actions-or">
          <span>{COPY.onboarding.or}</span>
          <Button tone="line" label={COPY.onboarding.signInWithGoogle} press={() => run(throughBrowser)} disabled={busy} />
        </p>
      )}
      {/* Always mounted, so the sentence arrives in a live region that already exists and is announced. */}
      {browserOffered && (
        <p className="actions" role="status" aria-live="polite">
          {inBrowser ? COPY.onboarding.waitingForBrowser : ""}
          {inBrowser && <Button tone="quiet" label={COPY.common.cancel} press={cancelBrowser} />}
        </p>
      )}
    </>
  );
}

/** Step 3. The size first, then the download, then the check on this machine. */
function Model({shell}: {shell: Shell}): ReactNode {
  const [state, askDownload, refused] = useDownload();
  const [checking, setChecking] = useState(false);
  const [failed, setFailed] = useState(false);
  const heading = useHeading();

  // A REFUSED read is not "no model on disk": main did not answer at all, and treating a refusal as
  // `missing` used to offer a download button that would just be refused again. The honest move is
  // the same as everywhere else this window cannot reach the app: one sentence, one retry.
  if (refused) {
    return (
      <>
        <h1 className="title" tabIndex={-1} ref={heading}>{COPY.onboarding.model}</h1>
        <Unreachable retry={askDownload} />
      </>
    );
  }

  const view = downloadView(state ?? {kind: "missing"}, shell.appInfo.modelSizeBytes);

  const check = async () => {
    setChecking(true);
    setFailed(false);
    const result = await clave.selfTest();
    setChecking(false);
    setFailed(!result.ok);
    shell.askStatus();
  };

  const size = gigabytes(shell.appInfo.modelSizeBytes);
  const act = (): ReactNode => {
    switch (view.phase) {
      case "idle":
        return <p className="actions"><Button tone="ink" label={COPY.onboarding.download(size)} press={() => clave.downloadStart()} /></p>;
      case "running":
        return <p className="actions"><Button label={COPY.onboarding.pause} press={() => clave.downloadPause()} /></p>;
      case "paused":
        return <p className="actions"><Button tone="ink" label={COPY.onboarding.resume} press={() => clave.downloadStart()} /></p>;
      case "verifying":
        return <p className="note">{COPY.onboarding.verifying}</p>;
      case "error":
        return (
          <>
            <p className="problem">{downloadProblem(view.errorCode)}</p>
            <p className="actions"><Button tone="ink" label={COPY.common.tryAgain} press={() => clave.downloadStart()} /></p>
          </>
        );
      // The file is on disk and verified; what is left is the self-test this machine has to pass.
      case "ready":
        return checking ? <p className="note">{COPY.onboarding.checking}</p> : (
          <>
            {failed ? <p className="problem">{COPY.onboarding.selfTestFailed}</p> : null}
            <p className="actions"><Button tone="ink" label={BLOCKERS.SELF_TEST_NEEDED.action} press={check} /></p>
          </>
        );
    }
  };

  return (
    <>
      <h1 className="title" tabIndex={-1} ref={heading}>{COPY.onboarding.model}</h1>
      <p className="lede">{COPY.onboarding.modelSize(size)}</p>
      {view.phase === "running" || view.phase === "paused" || view.phase === "verifying"
        ? <Meter label={COPY.onboarding.progress} percent={view.percent} />
        : null}
      <div>{act()}</div>
    </>
  );
}

/** How often the Screen Recording grant is looked at again while that step is on screen. */
const PERMISSION_POLL_MS = 1500;

/**
 * Step 4. What macOS is about to show, in the order the user meets it, and then the grant is polled
 * until it arrives. No restart is asked for on this path: the app notices the grant by itself, which
 * is what the owner measured on macOS 27 and what the three steps promise. The restart branch below
 * is the rare case `PERMISSION_NEEDS_RESTART` really describes — a fresh reader refused as well — and
 * it keeps its own sentence and its own button.
 */
function PermissionStep({shell}: {shell: Shell}): ReactNode {
  // Running from macOS's translocation folder: nothing is asked for until the app has been moved
  // (main's requestPermission is a no-op there too). Decided before any hook so the hooks below
  // stay unconditional: the branch renders its own component.
  if (isTranslocated(shell.appInfo)) return <MoveToApplications />;
  return <PermissionAsk shell={shell} />;
}

/** The permission step's stand-in while the app runs from the translocation folder. */
function MoveToApplications(): ReactNode {
  const heading = useHeading();
  return (
    <>
      <h1 className="title" tabIndex={-1} ref={heading}>{COPY.onboarding.translocated.title}</h1>
      <p className="lede">{COPY.onboarding.translocated.lead}</p>
      <ol className="steps">{COPY.onboarding.translocated.steps(APP_FILE).map((instruction) => <li key={instruction}>{instruction}</li>)}</ol>
    </>
  );
}

function PermissionAsk({shell}: {shell: Shell}): ReactNode {
  const [permission, setPermission] = useState<Permission | null>(null);
  const [waitedLong, setWaitedLong] = useState(false);
  const {askStatus} = shell;
  const heading = useHeading();

  /**
   * macOS does not tell the app when the grant changes, so this is the one poll in the window. It
   * re-reads the status ONLY when the answer actually changed: re-reading it on every tick made the
   * whole window ask main for a fresh status two-thirds of a second apart for as long as this step
   * was open, and every one of those answers re-rendered four screens' worth of state to say the
   * same thing. The poll is cleared on unmount, and a rejection is swallowed on purpose — the next
   * tick asks again.
   *
   * The same tick answers "has this been going on a while?" (`stillWaiting`, with the rule and the
   * threshold in model/views.ts) rather than a second timer being started for it. It is set on every
   * tick and not just once, because setting a boolean to the value it already holds is a no-op in
   * React — it costs nothing and needs no `if` here to protect the render count the paragraph above
   * is about. `askStatus` is a `useCallback` with no dependencies, so this effect runs once per
   * mount and `startedAt` is when the step appeared.
   */
  useEffect(() => {
    let live = true;
    let last: Permission | null = null;
    const startedAt = Date.now();
    const look = () => {
      if (live) setWaitedLong(stillWaiting(startedAt, Date.now()));
      void clave.recheckPermission().then(
        (next) => {
          if (!live) return;
          setPermission(next);
          if (next === last) return;
          last = next;
          askStatus();
        },
        () => undefined
      );
    };
    look();
    const timer = setInterval(look, PERMISSION_POLL_MS);
    return () => { live = false; clearInterval(timer); };
  }, [askStatus]);

  const needsRestart = permission === "needsRestart" || shell.status.blockers.includes("PERMISSION_NEEDS_RESTART");
  return (
    <>
      <h1 className="title" tabIndex={-1} ref={heading}>{COPY.onboarding.screenRecording}</h1>
      <p className="lede">{COPY.onboarding.permission.lead}</p>
      {needsRestart
        ? (
          <>
            <p className="note">{BLOCKERS.PERMISSION_NEEDS_RESTART.sentence}</p>
            <p className="actions"><Button tone="ink" label={BLOCKERS.PERMISSION_NEEDS_RESTART.action} press={() => clave.restartApp()} /></p>
          </>
        )
        : (
          <>
            {/* Numbered because the three really are a sequence: the order is the information, and it
                is the order macOS will put them in. Keyed by the sentence, as every other list here
                is — the copy is the identity, there is no id to key by. */}
            <ol className="steps">{PERMISSION_STEPS.map((instruction) => <li key={instruction}>{instruction}</li>)}</ol>
            <p className="note">{COPY.onboarding.permission.aside}</p>
            <p className="actions"><Button tone="ink" label={BLOCKERS.NO_PERMISSION.action} press={() => clave.requestPermission()} /></p>
            <p className="note">{COPY.onboarding.checkingPermission}</p>
            {waitedLong ? <p className="note">{COPY.onboarding.stillWaitingPermission}</p> : null}
          </>
        )}
    </>
  );
}

/** Step 5. What is never read: editable here, with the limits stated plainly. */
function NeverRead({shell}: {shell: Shell}): ReactNode {
  const [appsProblem, setAppsProblem] = useState<SettingsProblem | null>(null);
  const [sitesProblem, setSitesProblem] = useState<SettingsProblem | null>(null);
  const [stepProblem, setStepProblem] = useState<SettingsProblem | null>(null);
  const {settings, save} = shell;
  const heading = useHeading();

  /**
   * One problem state per thing that can be saved, exactly as Settings does it: the apps list, the
   * sites list, and Continue. Sharing one between them put "that entry cannot be used" under the
   * sites box because the apps box had refused, and left Continue failing in silence.
   */
  const into = (show: (problem: SettingsProblem | null) => void) => async (patch: Parameters<Shell["save"]>[0]): Promise<boolean> => {
    const problem = await save(patch);
    show(problem);
    return problem === null;
  };
  const sentence = (problem: SettingsProblem | null) => (problem === null ? null : SETTINGS_PROBLEMS[problem]);

  return (
    <>
      <h1 className="title" tabIndex={-1} ref={heading}>{COPY.onboarding.neverRead}</h1>
      <EntryList
        label={COPY.onboarding.apps}
        entries={settings.exclusions}
        placeholder={COPY.settings.addApp}
        problem={sentence(appsProblem)}
        save={(exclusions) => into(setAppsProblem)({exclusions})}
      />
      <EntryList
        label={COPY.onboarding.sites}
        entries={settings.excludedSites}
        placeholder={COPY.settings.addSite}
        problem={sentence(sitesProblem)}
        save={(excludedSites) => into(setSitesProblem)({excludedSites})}
      />
      <p className="note">{COPY.onboarding.privateWindows}</p>
      <div>
        <p className="label">{COPY.onboarding.limits}</p>
        <ul className="plain">{KNOWN_LIMITS.map((limit) => <li key={limit}>{limit}</li>)}</ul>
      </div>
      {sentence(stepProblem) === null ? null : <p className="problem">{sentence(stepProblem)}</p>}
      <p className="actions"><Button tone="ink" label={COPY.common.continue} press={() => into(setStepProblem)({onboardingStep: 5})} /></p>
    </>
  );
}

/** Step 6. The review time. The 17:30 default is the settings default, not a second opinion here. */
function ReviewTime({shell}: {shell: Shell}): ReactNode {
  const [time, setTime] = useState(shell.settings.reviewTime);
  const [problem, setProblem] = useState<SettingsProblem | null>(null);
  const [busy, run] = useAction();
  const heading = useHeading();

  // One patch, so a refused time does not advance the step. `6` puts the LAST step on screen; it is
  // that step's own button that ends onboarding.
  const submit = async () => { setProblem(await shell.save({reviewTime: time, onboardingStep: 6})); };

  return (
    <>
      <h1 className="title" tabIndex={-1} ref={heading}>{COPY.onboarding.reviewTimeTitle}</h1>
      <p className="lede">{COPY.onboarding.reviewTime}</p>
      <form onSubmit={(event) => { event.preventDefault(); run(submit); }}>
        <Field label={COPY.onboarding.reviewTimeLabel} problem={problem === null ? null : SETTINGS_PROBLEMS[problem]}>
          {(id, describedBy) => <input id={id} className="time" type="time" value={time} aria-describedby={describedBy} onChange={(e) => setTime(e.target.value)} />}
        </Field>
        <p className="actions"><Submit tone="ink" label={COPY.common.continue} busy={busy} /></p>
      </form>
    </>
  );
}

/**
 * Step 7. Nothing is switched on here: the user does that on the home screen, or from the tray.
 *
 * Its button writes `onboardingStep: 7`, and that number — not the `6` the previous step wrote — is
 * what ends onboarding. Then the window moves itself: `startScreen` opens on review if something is
 * already waiting and on home otherwise, which is one decision in one place.
 */
function Done({shell}: {shell: Shell}): ReactNode {
  const [problem, setProblem] = useState<SettingsProblem | null>(null);
  const heading = useHeading();
  return (
    <>
      <h1 className="title" tabIndex={-1} ref={heading}>{COPY.onboarding.doneTitle}</h1>
      <p className="lede">{COPY.onboarding.done}</p>
      {problem === null ? null : <p className="problem">{SETTINGS_PROBLEMS[problem]}</p>}
      <p className="actions">
        <Button tone="ink" label={COPY.onboarding.finish} press={async () => setProblem(await shell.save({onboardingStep: 7}))} />
      </p>
    </>
  );
}
