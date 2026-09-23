# What leaves this machine

Clave Agent reads the text on your screen to find evidence of your skills. This page says exactly
what it keeps, what it sends, and what it never does. It is written to be checked: run the app with
your Wi-Fi off, or watch its network traffic, and compare.

## The five promises

1. You switch it on and off yourself. It never runs unless you started it.
2. It reads the text on your screen. Anything it captures to do that is deleted within seconds.
   Nothing older than an hour exists anywhere, and nothing is stored on disk.
3. It never reads the apps and sites you exclude, or private browser windows it can recognise.
4. Nothing reaches your profile until you read it and say yes. It names no one else.
5. It works with your Wi-Fi off. Only the short statements you approve ever leave.

## What is sent, and when

| What | When | To |
|---|---|---|
| Your email or handle and your password | when you sign in (the password is never stored) | Clave |
| If you choose "Sign in with Google": your own browser goes to Clave's Google sign-in page (the app never sees that password); Clave then sends your browser back to this app with a one-time code, and the app sends that code to Clave in exchange for your sign-in token | when you choose that button | Google, through your browser; then Clave |
| A request for your own profile, which answers with the display names on your account | right after you sign in | Clave |
| Your sign-in token, to be renewed | when it is within a day of expiring, and once more if a request is refused | Clave |
| A request for the public list of skills, naming the version it already has | at sign-in, then once a day; after a failed check, again after fifteen minutes | Clave |
| Each statement you approved: its text, the skill or competency it is about, when it was written, version numbers, and a random id for the statement so a repeat never counts twice | after you press Approve | Clave |
| A request for the model file (about 2.7 GB, one time) | during set-up | `huggingface.co`, unless you point the app somewhere else |

Nothing else. No screenshots, no screen text, no window titles, no app names, no file names, no
rejected statements, no usage data. The "Sent" list in the app shows every statement Clave kept; the
rare one Clave refused is named there as well, below.

Your own display names are asked for so that the app can keep *your* name out of your statements;
they are stored on this machine, encrypted, and never sent anywhere. The site the model is
downloaded from sees what any download shows a web server: your IP address and that a file was
fetched. It is told nothing about you, your account or your screen, and it is asked for nothing
after set-up.

## What is kept on this machine

- In memory only, for at most sixty minutes: the text that was read, already stripped of passwords,
  keys, emails, card and phone numbers. It is gone when you quit.
- On disk, encrypted with your Keychain on macOS, with your Windows account's data protection on
  Windows, or with your login keyring on Linux: your sign-in token and the display names on your
  account, the statements waiting for your answer, approved statements that have not been uploaded
  yet, and on Linux the permission to share your screen.
  A statement Clave refuses (for example because the skill it names has since been retired) was
  sent but not kept: it is removed from that waiting list and is not in "Sent"; the log records only
  that one was refused.
- On disk, readable: your settings, the public list of skills, the list of what was sent, the model
  file, and a log that can only hold fixed codes and numbers, never text.
- "Delete all local data" in Settings removes all of it.

## On Linux

On Linux the app sees your screen through GNOME's own screen sharing, the same one a video call
uses. GNOME asks you once which screen to share. While the app is reading, GNOME shows its sharing
icon in the top bar. Press Stop there and the app stops reading, forgets the permission, and does
not share again until you choose Share in GNOME's dialog. When your screen locks, GNOME pauses the
sharing, and the app carries on after you unlock.

GNOME shares a whole screen, but the app keeps only the window in front: each picture is cut down to
that window in memory straight away, and the rest is never read or stored. Windows on a screen you
did not share are not read.

To know which window is in front and where it is, the app installs a small GNOME extension, Clave
focus, for your account only. It tells the app's own reader, and no other program, the front
window's app name, title, position and size. It says nothing while GNOME's overview, a menu or a
notification is on top. It sends nothing anywhere. Like anything on your desktop, a program already
running as you could watch that answer go by. Settings has "Remove the GNOME extension".

## What the automatic check cannot do

Before you see a statement, the app discards any that contains a name, company, product, file,
address, ticket number or figure that was on your screen. It cannot recognise:

- a confidential fact that is phrased in ordinary words;
- a name written entirely in capital letters.

That is why nothing leaves until you have read it and said yes.
