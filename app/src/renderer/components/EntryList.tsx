import type {ReactNode} from "react";
import {useId, useState} from "react";
import {COPY} from "../copy";
import {addEntry, removeEntry} from "../model/controls";
import {Submit, useAction} from "./Controls";

/**
 * A list of excluded apps or sites, edited in place. The same component serves onboarding's "what
 * is never read" and Settings, so the two can never drift into two different ideas of what an
 * exclusion is. `save` is the real `updateSettings` call: what is on screen is always what main
 * last confirmed, and an entry it refuses is reported next to the field it was typed in.
 *
 * `save` answers whether main TOOK the entry, and the typed draft is cleared only then. Clearing it
 * first threw away what the user wrote whenever the save was refused — leaving a validation message
 * next to an empty box and nothing to correct.
 */
export function EntryList({label, entries, placeholder, problem, save, children}: {
  label: string;
  entries: readonly string[];
  placeholder: string;
  problem?: string | null;
  save: (next: string[]) => Promise<boolean>;
  children?: ReactNode;
}): ReactNode {
  const [draft, setDraft] = useState("");
  const [busy, run] = useAction();
  const id = useId();
  const problemId = `${id}-problem`;

  const add = async () => {
    const next = addEntry(entries, draft);
    if (next === null) return;
    if (await save(next)) setDraft("");
  };

  return (
    <div className="field">
      <label className="label" htmlFor={id}>{label}</label>
      {entries.length === 0 ? null : (
        <ul className="entries">
          {entries.map((entry) => (
            <li key={entry}>
              <span className="entry-name">{entry}</span>
              <button type="button" className="entry-drop" aria-label={COPY.common.remove(entry)} onClick={() => run(() => save(removeEntry(entries, entry)))}>
                {"×"}
              </button>
            </li>
          ))}
        </ul>
      )}
      <form
        className="entryform"
        onSubmit={(event) => {
          event.preventDefault();
          run(add);
        }}
      >
        <input
          id={id}
          className="input"
          type="text"
          value={draft}
          placeholder={placeholder}
          autoComplete="off"
          spellCheck={false}
          aria-describedby={problem == null ? undefined : problemId}
          onChange={(event) => setDraft(event.target.value)}
        />
        <Submit label={COPY.common.add} busy={busy} />
      </form>
      {children}
      {problem == null ? null : <p className="problem" id={problemId}>{problem}</p>}
    </div>
  );
}
