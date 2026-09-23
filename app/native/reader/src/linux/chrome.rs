//! Which language Chrome's own interface is in on Linux, for the one question the reader has about
//! it: is its incognito badge the English word the app looks for? The Linux counterpart of
//! `win/chrome.rs`, whose doc comment has the measurement that makes this matter (a Russian badge
//! came back from recognition as noise, and the title said nothing, so an incognito window would
//! have been read).
//!
//! Chrome's own answer is read, not worked out again. Chromium's `ui/base/l10n/l10n_util.cc` (read
//! 2026-09-23, `main`) decides the interface language on Linux from the environment alone
//! (`LANGUAGE`, `LC_ALL`, `LC_MESSAGES`, `LANG`; neither `--lang` nor the `intl.app_locale` setting),
//! and the browser then hands what it decided to its child processes as `--lang=<locale>`, which is
//! the comment's own reason for the switch. Measured in the VM the same day (Chrome 154, arm64):
//! started with `LANG=pt_BR.UTF-8`, the network service (a child of the browser) and every renderer
//! (grandchildren, through the zygote) carried `--lang=pt-BR`; with `LANG=en_US.UTF-8`, `--lang=en-US`.
//!
//! The environment itself cannot be read from outside: Chrome sets its process title by writing over
//! the memory its environment started in, so `/proc/<pid>/environ` of the browser held none of the
//! four variables in either run. The children's command lines are titles too, one string with the
//! switches separated by spaces, so they are split on spaces as well as NULs.
//!
//! The rule: every `--lang` among the processes descended from the window's own process must be
//! English, and there must be at least one. A Chrome that has not started a child yet (its first
//! second), a pid Mutter does not know, or a process tree that cannot be read is not English: what
//! this module cannot show to be English is not English. A found answer is kept for that process
//! (pid and start time), since Chrome's language is fixed until it restarts. Nothing read here is
//! kept beyond that answer or reported.

use std::sync::Mutex;

/// The app ids GNOME gives Chrome's windows: the .deb's desktop entries for the three channels.
/// Measured for the stable channel in the VM on 2026-09-23 (`google-chrome.desktop`); only an id
/// with a measured band (`toolbar.rs`) is ever read, so the rule matters for those alone.
pub const APP_IDS: [&str; 3] = ["google-chrome.desktop", "google-chrome-beta.desktop", "google-chrome-unstable.desktop"];

/// How far below the window's process `--lang` is looked for: renderers sit at depth 3 (browser,
/// zygote, zygote, renderer).
const MAX_DEPTH: usize = 4;

pub fn is_chrome(bundle_id: Option<&str>) -> bool {
    bundle_id.is_some_and(|id| APP_IDS.contains(&id))
}

/// One process as `/proc` shows it: its parent and its command line.
#[derive(Debug, Clone)]
struct Process {
    pid: u32,
    parent: u32,
    cmdline: Vec<u8>,
}

/// The last answer found, for one Chrome process: (pid, start time, English). Only an answer made
/// from at least one `--lang` is kept; "none found yet" is asked again next time.
#[derive(Debug, Default)]
struct Known(Option<(u32, u64, bool)>);

impl Known {
    fn answer(&mut self, pid: u32, started: u64, scan: impl FnOnce() -> Vec<String>) -> bool {
        if let Some((known_pid, known_start, english)) = self.0 {
            if known_pid == pid && known_start == started {
                return english;
            }
        }
        let langs = scan();
        if langs.is_empty() {
            return false;
        }
        let english = decide(&langs);
        self.0 = Some((pid, started, english));
        english
    }
}

static KNOWN: Mutex<Known> = Mutex::new(Known(None));

/// Whether the Chrome whose browser process is `pid` shows its interface in English. `false`
/// whenever that cannot be shown.
pub fn interface_is_english(pid: Option<u32>) -> bool {
    let Some(pid) = pid else { return false };
    let Some(started) = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok().as_deref().and_then(start_time) else {
        return false;
    };
    KNOWN.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).answer(pid, started, || descendant_langs(&processes(), pid))
}

/// Every process `/proc` lists now. One that ends while it is being read is left out.
fn processes() -> Vec<Process> {
    let Ok(entries) = std::fs::read_dir("/proc") else { return Vec::new() };
    entries
        .filter_map(|entry| {
            let pid: u32 = entry.ok()?.file_name().to_str()?.parse().ok()?;
            let parent = parent_of(&std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?)?;
            let cmdline = std::fs::read(format!("/proc/{pid}/cmdline")).ok()?;
            Some(Process { pid, parent, cmdline })
        })
        .collect()
}

/// The fields of `/proc/<pid>/stat` after the command name, which is in parentheses and may itself
/// hold spaces and parentheses: everything after the LAST `)`.
fn fields_after_name(stat: &str) -> Option<Vec<&str>> {
    Some(stat.rsplit_once(')')?.1.split_whitespace().collect())
}

/// Field 4, the parent's pid.
fn parent_of(stat: &str) -> Option<u32> {
    fields_after_name(stat)?.get(1)?.parse().ok()
}

/// Field 22, the start time in clock ticks since boot: with the pid, it names one process.
pub(super) fn start_time(stat: &str) -> Option<u64> {
    fields_after_name(stat)?.get(19)?.parse().ok()
}

/// The `--lang` values of the processes descended from `root` (not `root` itself), at most
/// [`MAX_DEPTH`] below it.
fn descendant_langs(processes: &[Process], root: u32) -> Vec<String> {
    let parents: std::collections::HashMap<u32, u32> = processes.iter().map(|process| (process.pid, process.parent)).collect();
    let parent = |pid: u32| parents.get(&pid).copied();
    let below_root = |process: &Process| {
        let mut ancestor = process.parent;
        for _ in 0..MAX_DEPTH {
            if ancestor == root {
                return true;
            }
            match parent(ancestor) {
                Some(next) if next != ancestor => ancestor = next,
                _ => return false,
            }
        }
        false
    };
    processes
        .iter()
        .filter(|process| process.pid != root && below_root(process))
        .flat_map(|process| lang_switches(&process.cmdline))
        .collect()
}

/// The `--lang=` values on a command line, whether its arguments are separated by NULs (as
/// `execve` left them) or by spaces (a process title). The program itself is not an argument.
fn lang_switches(cmdline: &[u8]) -> Vec<String> {
    cmdline
        .split(|&byte| byte == 0 || byte.is_ascii_whitespace())
        .filter(|part| !part.is_empty())
        .skip(1)
        .filter_map(|part| part.strip_prefix(b"--lang="))
        .map(|value| String::from_utf8_lossy(value).into_owned())
        .collect()
}

fn decide(langs: &[String]) -> bool {
    !langs.is_empty() && langs.iter().all(|lang| is_english(lang))
}

/// "en", or English with a territory: "en-US", "en-GB", "en_US". Nothing that merely starts with
/// the letters "en", and not Chrome's accented pseudolocale `en-XA`.
fn is_english(tag: &str) -> bool {
    let tag = tag.trim().to_ascii_lowercase().replace('_', "-");
    (tag == "en" || tag.starts_with("en-")) && tag != "en-xa"
}

#[cfg(test)]
mod tests {
    use super::*;

    fn process(pid: u32, parent: u32, cmdline: &str) -> Process {
        Process { pid, parent, cmdline: cmdline.as_bytes().to_vec() }
    }

    /// The tree measured in the VM, as pids and command lines (the values of the other switches cut).
    fn chrome_tree(lang: &str) -> Vec<Process> {
        vec![
            process(1, 1, "/sbin/init"),
            process(900, 1, "/usr/bin/gnome-shell"),
            process(1000, 900, "/opt/google/chrome/chrome"),
            process(1010, 1000, &format!("/opt/google/chrome/chrome --type=utility --utility-sub-type=network.mojom.NetworkService --lang={lang} --service-sandbox-type=none")),
            process(1020, 1000, "/opt/google/chrome/chrome --type=zygote --no-zygote-sandbox"),
            process(1021, 1000, "/opt/google/chrome/chrome --type=zygote"),
            process(1030, 1021, "/opt/google/chrome/chrome --type=zygote"),
            process(1040, 1030, &format!("/opt/google/chrome/chrome --type=renderer --lang={lang} --num-raster-threads=2")),
            process(1050, 1020, "/opt/google/chrome/chrome --type=gpu-process"),
            // Another program's process, with its own --lang: not Chrome's.
            process(2000, 900, "/usr/bin/other --type=renderer --lang=ru"),
        ]
    }

    #[test]
    fn chromes_children_say_its_language() {
        assert_eq!(descendant_langs(&chrome_tree("en-US"), 1000), ["en-US", "en-US"]);
        assert!(decide(&descendant_langs(&chrome_tree("en-US"), 1000)));
        assert!(!decide(&descendant_langs(&chrome_tree("pt-BR"), 1000)));
    }

    #[test]
    fn only_the_window_process_own_descendants_count() {
        let mut tree = chrome_tree("en-US");
        // A --lang on the browser's own command line is not what it decided.
        tree[2] = process(1000, 900, "/opt/google/chrome/chrome --lang=ru");
        assert!(decide(&descendant_langs(&tree, 1000)));
        // Nothing of the other program's tree reaches Chrome's answer, and the other way round.
        assert_eq!(descendant_langs(&chrome_tree("en-US"), 2000), Vec::<String>::new());
        assert_eq!(descendant_langs(&chrome_tree("en-US"), 4242), Vec::<String>::new());
    }

    #[test]
    fn every_lang_found_must_be_english_and_one_must_be_found() {
        let mut tree = chrome_tree("en-US");
        tree.push(process(1041, 1030, "/opt/google/chrome/chrome --type=renderer --lang=de"));
        assert!(!decide(&descendant_langs(&tree, 1000)));
        // A Chrome that has not started its children yet.
        let bare = vec![process(1000, 900, "/opt/google/chrome/chrome")];
        assert!(!decide(&descendant_langs(&bare, 1000)));
    }

    #[test]
    fn descendants_are_looked_for_only_so_deep_and_a_loop_ends() {
        let mut deep = vec![process(1000, 900, "chrome")];
        for depth in 1..=6u32 {
            deep.push(process(1000 + depth, 1000 + depth - 1, &format!("chrome --lang=x{depth}")));
        }
        assert_eq!(descendant_langs(&deep, 1000), ["x1", "x2", "x3", "x4"]);
        let looped = vec![process(10, 11, "a --lang=en"), process(11, 10, "b --lang=en")];
        assert_eq!(descendant_langs(&looped, 99), Vec::<String>::new());
    }

    #[test]
    fn switches_are_read_from_nul_or_space_separated_command_lines() {
        assert_eq!(lang_switches(b"chrome\0--type=renderer\0--lang=pt-BR\0"), ["pt-BR"]);
        assert_eq!(lang_switches(b"/opt/google/chrome/chrome --type=utility --lang=en-US --x=1"), ["en-US"]);
        // The program itself is not an argument, and look-alikes are other switches.
        assert!(lang_switches(b"--lang=en --language=ru --langs=ru -lang=ru").is_empty());
        assert!(lang_switches(b"").is_empty());
    }

    #[test]
    fn the_parent_and_start_time_come_from_after_the_last_parenthesis() {
        let stat = "1010 (chrome (x) y) S 1000 1010 900 0 -1 4194560 100 0 0 0 5 2 0 0 20 0 9 0 86342 123 45";
        assert_eq!(parent_of(stat), Some(1000));
        assert_eq!(start_time(stat), Some(86342));
        assert_eq!(parent_of("garbage"), None);
        assert_eq!(start_time("1 (a) S 0"), None);
    }

    #[test]
    fn english_is_every_english_tag_and_nothing_that_merely_starts_with_en() {
        for tag in ["en", "EN", "en-US", "en-GB", "en_US", " en-us "] {
            assert!(is_english(tag), "{tag}");
        }
        // `en-XA` is Chrome's accented pseudolocale ("Ĩñçõĝñĩţõ"): not the English word (Task 6 review).
        for tag in ["", "eng", "enx", "es", "pt-BR", "de-EN", "en\u{fffd}", "en-XA", "en_xa", "EN-XA"] {
            assert!(!is_english(tag), "{tag}");
        }
    }

    #[test]
    fn only_chromes_own_ids_are_chrome() {
        for id in APP_IDS {
            assert!(is_chrome(Some(id)), "{id}");
        }
        for other in [None, Some("chromium_chromium.desktop"), Some("google-chrome"), Some("firefox_firefox.desktop"), Some("")] {
            assert!(!is_chrome(other), "{other:?}");
        }
    }

    #[test]
    fn an_answer_is_kept_for_one_process_and_none_found_is_asked_again() {
        let langs = |values: &[&str]| values.iter().map(|value| (*value).to_owned()).collect::<Vec<_>>();
        let mut known = Known::default();
        // Chrome's first second: no child yet. Not English, and not remembered.
        assert!(!known.answer(1000, 50, || langs(&[])));
        assert!(known.answer(1000, 50, || langs(&["en-US"])));
        // Kept: the same process is not scanned again.
        assert!(known.answer(1000, 50, || panic!("scanned again")));
        // The same pid with another start time is another process.
        assert!(!known.answer(1000, 51, || langs(&["pt-BR"])));
        assert!(!known.answer(1000, 51, || panic!("scanned again")));
        assert!(known.answer(1001, 51, || langs(&["en-GB"])));
    }

    #[test]
    fn an_unknown_or_unreadable_process_is_not_english() {
        assert!(!interface_is_english(None));
        assert!(!interface_is_english(Some(0)));
        assert!(!interface_is_english(Some(u32::MAX)));
    }

    /// A process tree like Chrome's: a parent whose child carries `--lang` as a real argument.
    fn judged(lang: &str) -> bool {
        let mut parent = std::process::Command::new("sh")
            .arg("-c")
            .arg(format!("sh -c 'sleep 5; :' child --type=utility --lang={lang} & wait"))
            .spawn()
            .expect("sh");
        let mut english = false;
        for _ in 0..40 {
            if !descendant_langs(&processes(), parent.id()).is_empty() {
                english = interface_is_english(Some(parent.id()));
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        let _ = parent.kill();
        let _ = parent.wait();
        english
    }

    #[test]
    fn a_running_process_tree_is_judged_by_its_childrens_lang() {
        assert!(judged("en-US"));
        assert!(!judged("pt-BR"));
    }
}
