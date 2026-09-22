import type {ReactNode} from "react";
import {useEffect, useState} from "react";
import type {EngineStatus, SettingsProblem} from "../../shared/ipc";
import {clave, useAsked} from "../bridge";
import {Button, Field, Submit, useAction, useHeading} from "../components/Controls";
import {EntryList} from "../components/EntryList";
import {FLAVOUR} from "../../shared/flavour";
import {COPY, SETTINGS_PROBLEMS} from "../copy";
import type {Shell} from "../shell";

/**
 * Settings, and nothing beyond what spec section 7 lists. Opening the screen tells main the settings
 * were looked at (`settingsOpened`), which is what clears SETTINGS_NEED_REVIEW after a recovered
 * file — so the blocker is cleared by the user actually reading the list, not by a button that says
 * they did.
 *
 * Every field reports its OWN validation problem, next to itself: three separate pieces of state
 * rather than one, because "that entry cannot be used" under the review time would be a lie.
 */
export function Settings({shell}: {shell: Shell}): ReactNode {
  const {settings, save, appInfo} = shell;
  const [recent] = useAsked(clave.recentApp);
  const [appsProblem, setAppsProblem] = useState<SettingsProblem | null>(null);
  const [sitesProblem, setSitesProblem] = useState<SettingsProblem | null>(null);
  const [timeProblem, setTimeProblem] = useState<SettingsProblem | null>(null);
  const [time, setTime] = useState(settings.reviewTime);
  const [timeBusy, runTime] = useAction();
  const [licencesMissing, setLicencesMissing] = useState(false);
  const heading = useHeading();

  // Nothing depends on the answer, but a rejected IPC call is still a rejected promise: unhandled,
  // it reaches the process as an unhandled rejection. Losing the acknowledgement costs the user one
  // extra visit to this screen, which is the right price for not crashing the window over it.
  useEffect(() => { void clave.settingsOpened().catch(() => undefined); }, []);

  const sentence = (problem: SettingsProblem | null) => (problem === null ? null : SETTINGS_PROBLEMS[problem]);
  /** Saves, shows the problem next to the field it belongs to, and reports whether main took it. */
  const into = (show: (problem: SettingsProblem | null) => void) => async (patch: Parameters<Shell["save"]>[0]): Promise<boolean> => {
    const problem = await save(patch);
    show(problem);
    return problem === null;
  };
  const saveApps = into(setAppsProblem);

  return (
    <div className="enter">
      <h1 className="title" tabIndex={-1} ref={heading}>{COPY.settings.title}</h1>

      <EntryList
        label={COPY.settings.apps}
        entries={settings.exclusions}
        placeholder={COPY.settings.addApp}
        problem={sentence(appsProblem)}
        save={(exclusions) => saveApps({exclusions})}
      >
        {/* Case-insensitively, the same way `addEntry` refuses a duplicate: offering to exclude
            "slack" when "Slack" is already in the list would write a second entry for one app. */}
        {recent === null || settings.exclusions.some((app) => app.toLowerCase() === recent.toLowerCase()) ? null : (
          <p className="actions">
            <Button
              label={COPY.settings.addCurrent(recent)}
              press={() => saveApps({exclusions: [...settings.exclusions, recent]})}
            />
          </p>
        )}
        {/* Not an entry the user can remove: which browsers are read is decided by what the reader can measure. */}
        <p className="note">{COPY.onboarding.privateWindows}</p>
      </EntryList>

      <EntryList
        label={COPY.settings.sites}
        entries={settings.excludedSites}
        placeholder={COPY.settings.addSite}
        problem={sentence(sitesProblem)}
        save={(excludedSites) => into(setSitesProblem)({excludedSites})}
      />

      <form onSubmit={(event) => { event.preventDefault(); runTime(() => into(setTimeProblem)({reviewTime: time})); }}>
        <Field label={COPY.settings.reviewTime} problem={sentence(timeProblem)}>
          {(id, describedBy) => <input id={id} className="time" type="time" value={time} aria-describedby={describedBy} onChange={(e) => setTime(e.target.value)} />}
        </Field>
        <p className="actions"><Submit label={COPY.common.save} busy={timeBusy} /></p>
      </form>

      <div>
        <hr className="divider" />
        <p className="label">{COPY.settings.account}</p>
        <Account account={shell.status.account} />
        {/* No navigation here: the status that comes back is signed out, and the window turns into
            the sign-in by itself (App.tsx), the same way it does when the server signs the user out. */}
        <p className="actions"><Button label={COPY.settings.signOut} press={() => clave.signOut().then(shell.askStatus)} /></p>
      </div>

      <DeleteAll shell={shell} />

      <div>
        <hr className="divider" />
        <p className="label">{COPY.settings.about}</p>
        <dl className="facts">
          <div><dt>{COPY.settings.version}</dt><dd>{appInfo.version}</dd></div>
          <div><dt>{COPY.settings.modelHash}</dt><dd>{appInfo.modelSha256}</dd></div>
        </dl>
        {FLAVOUR === "internal" ? <p className="note">{COPY.settings.internalBuild}</p> : null}
        <p className="actions">
          <Button tone="quiet" label={COPY.common.whatLeaves} press={() => clave.openWhatLeaves()} />
          {/* The bundled licence file exists in packaged builds only; a missing one is said, not swallowed. */}
          <Button tone="quiet" label={COPY.settings.licences} press={() => clave.openLicences().then((result) => setLicencesMissing(result === "LICENCES_MISSING"), () => setLicencesMissing(true))} />
        </p>
        {licencesMissing ? <p className="note">{COPY.settings.licencesMissing}</p> : null}
      </div>
    </div>
  );
}

/** Who is signed in, so the user knows which account their evidence goes to. Only the parts the account has. */
function Account({account}: {account: EngineStatus["account"]}): ReactNode {
  if (account === null) return <p className="note">{COPY.settings.accountUnknown}</p>;
  return (
    <dl className="facts">
      {account.fullName !== null ? <div><dt>{COPY.settings.name}</dt><dd>{account.fullName}</dd></div> : null}
      {account.handle !== null ? <div><dt>{COPY.settings.handle}</dt><dd>@{account.handle}</dd></div> : null}
      {account.email !== null ? <div><dt>{COPY.settings.email}</dt><dd>{account.email}</dd></div> : null}
    </dl>
  );
}

/**
 * The one irreversible thing in the app, so it is the one thing that asks twice: the first press
 * only opens the question. Nothing is pre-ticked, the confirming button is the only oxide-red thing
 * anywhere, and Cancel is the ordinary-looking one.
 */
function DeleteAll({shell}: {shell: Shell}): ReactNode {
  const [asking, setAsking] = useState(false);
  const [removeModel, setRemoveModel] = useState(false);
  const [done, setDone] = useState(false);

  return (
    <div>
      <hr className="divider" />
      <p className="label">{COPY.settings.localData}</p>
      {done ? <p className="note">{COPY.settings.deleted}</p> : asking ? (
        <>
          <p className="warn">{COPY.settings.deleteWarning}</p>
          <label className="check">
            <input type="checkbox" checked={removeModel} onChange={(e) => setRemoveModel(e.target.checked)} />
            <span>{COPY.settings.alsoModel}</span>
          </label>
          <p className="actions">
            <Button
              tone="oxide"
              label={COPY.settings.deleteConfirm}
              press={async () => {
                await clave.deleteAllData({removeModel});
                setAsking(false);
                setDone(true);
                // Everything this window is showing has just been reset on disk: the exclusions,
                // the review time, the onboarding step, and the sign-in. Re-read both, or the
                // screen keeps displaying the settings of an account that no longer exists here.
                shell.askSettings();
                shell.askStatus();
              }}
            />
            <Button tone="quiet" label={COPY.common.cancel} press={() => { setAsking(false); setRemoveModel(false); }} />
          </p>
        </>
      ) : (
        <p className="actions"><Button label={COPY.settings.deleteAll} press={() => setAsking(true)} /></p>
      )}
    </div>
  );
}
