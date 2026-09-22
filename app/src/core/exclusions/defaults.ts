/** Always applied, matched on the EXACT app name. Not shown to the user and not removable. */
export const BUILT_IN_EXCLUSIONS = [
  "loginwindow", "ScreenSaverEngine", "LockApp", "LogonUI",
  "Dock", "SystemUIServer", "Control Center", "Notification Center", "Spotlight", "WindowManager",
  "Clave Agent"
];

/** Seeded on first run. The user can edit this list. Slack, Teams and Discord are work tools and are read. */
export const DEFAULT_EXCLUSIONS = [
  "1Password::", "Bitwarden::", "LastPass::", "Dashlane::", "KeePassXC::", "Keychain Access::", "Passwords::",
  "Telegram::", "WhatsApp::", "Messages::", "Signal::",
  "::online banking", "::internet banking", "::bank account", "::net banking"
];

export const DEFAULT_EXCLUDED_SITES = [
  "paypal.com", "wise.com", "revolut.com", "chase", "wellsfargo", "bankofamerica", "citi.com",
  "nubank.com.br", "itau.com.br", "bradesco", "santander", "accounts.google.com", "appleid.apple.com"
];

/**
 * Every browser we know of, matched as a NAME PREFIX on a word boundary (see `isBrowser`): an entry
 * matches the app name itself and any name that continues with a space, so one entry covers the
 * whole family — "Google Chrome Canary", "Brave Browser Beta", "Microsoft Edge Dev", "Firefox
 * Developer Edition", "Opera GX". The boundary is what keeps "Archive Utility" out of "arc",
 * "Operator" out of "opera" and "Minecraft" out of "min".
 */
export const BROWSERS = [
  "google chrome", "chrome", "chromium", "safari", "firefox", "microsoft edge", "brave browser",
  "arc", "opera", "vivaldi", "zen",
  "orion", "duckduckgo", "tor browser", "helium", "sigmaos", "librewolf", "waterfox", "floorp",
  "thorium", "yandex", "whale", "min"
];

/**
 * The browsers whose toolbar strip the reader can find: the height of the strip was measured for
 * these two and for no others (phase 0, P5), and it cannot be derived from the window. Private
 * windows and excluded sites are recognised from that strip, so a browser without one is not read at
 * all — unknown means no. A browser joins this list only together with a measured band in the
 * reader (`app/native/reader/src/toolbar.rs`), never on its own.
 */
export const MEASURED_BROWSERS = ["google chrome", "safari"];
