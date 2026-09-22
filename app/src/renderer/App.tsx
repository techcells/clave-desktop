import type {ReactNode} from "react";
import {useCallback, useEffect, useState} from "react";
import type {SettingsProblem, UserSettingsPatch} from "../shared/ipc";
import {clave, useAppInfo, useSettings, useStatus} from "./bridge";
import {Unreachable} from "./components/Boundary";
import type {Tone} from "./components/Frame";
import {Frame, NameSpine, StepSpine, Tabs} from "./components/Frame";
import {COPY} from "./copy";
import {parseRoute, routeHash} from "./model/route";
import type {Screen, Step} from "./model/views";
import {firstBlocker, onboardingStep, startScreen, STEPS} from "./model/views";
import {Home} from "./screens/Home";
import {Onboarding} from "./screens/Onboarding";
import {Review} from "./screens/Review";
import {Settings} from "./screens/Settings";
import type {Shell} from "./shell";

/** Onboarding is finished once EVERY step has been finished, the last one ("done") included. */
const FINISHED = STEPS.length;

/** What the spine is stamped with once onboarding is behind the user. */
const SPINE_NAME: Record<Exclude<Screen, "onboarding">, string> = {
  home: COPY.nav.home, review: COPY.nav.review, settings: COPY.nav.settings
};

/**
 * The window. It holds the four things main answers with (status, settings, app info, the location
 * hash) and hands them to whichever screen the state calls for. It decides nothing itself: which
 * screen is `startScreen`, which onboarding step is `onboardingStep`, which problem is
 * `firstBlocker` — all of them tested in model/views.ts. What is left here is plumbing.
 *
 * Navigation is the location HASH and never a new document: the page holds the live `onStatus` and
 * `onDownload` subscriptions, and loading a second file would drop them on the floor.
 */
export function App(): ReactNode {
  const [status, askStatus, statusFailed] = useStatus();
  const [settings, askSettings, settingsFailed] = useSettings();
  const [appInfo, askAppInfo, appInfoFailed] = useAppInfo();
  const [hash, setHash] = useState<string>(() => window.location.hash);

  useEffect(() => {
    const onHash = () => setHash(window.location.hash);
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const go = useCallback((screen: Screen, step: Step | null = null) => {
    window.location.hash = routeHash(screen, step);
    setHash(routeHash(screen, step));
  }, []);

  const save = useCallback(async (patch: UserSettingsPatch): Promise<SettingsProblem | null> => {
    const answer = await clave.updateSettings(patch);
    // Re-read either way: on success to pick up what main stored, on refusal to put back on screen
    // exactly what main still holds, so a refused edit never lingers as if it had been accepted.
    askSettings();
    return answer.ok ? null : answer.problem;
  }, [askSettings]);

  const finished = settings !== null && settings.onboardingStep >= FINISHED;
  const route = parseRoute(hash);
  const asked: Screen | null = finished ? (route?.screen ?? null) : "onboarding";
  const forcedStep: Step | null = finished && route?.screen === "onboarding" ? route.step : null;

  /**
   * A finished user sent back to one onboarding step by a home-screen fix button is sent home again
   * the moment that step is no longer needed — after the restart, or after the sign-in went through.
   * Without this the window would sit on a finished step with nothing to do on it.
   */
  const settledForcedStep = forcedStep !== null && status !== null && settings !== null && onboardingStep(status, settings) === "done";
  useEffect(() => {
    if (settledForcedStep) go("home");
  }, [settledForcedStep, go]);

  if (status === null || settings === null || appInfo === null) {
    /**
     * Nothing has arrived yet. Either main has not answered (the blank page is right for the one
     * frame that takes) or it REFUSED — and a refusal used to be swallowed, leaving the window blank
     * for good with nothing on it to press. One sentence and one button, the same as everywhere else.
     */
    const refused = statusFailed || settingsFailed || appInfoFailed;
    return (
      <Frame spine={null} tone={refused ? "problem" : "off"} announce="" tabs={null}>
        {refused ? <Unreachable retry={() => { askStatus(); askSettings(); askAppInfo(); }} /> : null}
      </Frame>
    );
  }

  const screen: Screen = asked ?? startScreen(status, settings);
  const shell: Shell = {status, settings, appInfo, askStatus, askSettings, go, save};
  const step: Step = forcedStep ?? onboardingStep(status, settings);
  const tone: Tone = firstBlocker(status) !== null ? "problem" : status.capture === "on" ? "on" : "off";

  return (
    <Frame
      spine={screen === "onboarding" ? <StepSpine step={step} /> : <NameSpine name={SPINE_NAME[screen]} />}
      tone={tone}
      announce={status.capture === "on" ? COPY.tray.on : COPY.tray.off}
      tabs={finished ? <Tabs here={screen} pending={status.pending} go={go} /> : null}
    >
      {screen === "onboarding" ? <Onboarding shell={shell} step={step} forced={forcedStep !== null} />
        : screen === "review" ? <Review shell={shell} />
        : screen === "settings" ? <Settings shell={shell} />
        : <Home shell={shell} />}
    </Frame>
  );
}
