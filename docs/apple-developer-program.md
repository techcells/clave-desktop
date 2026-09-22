# Getting the Apple Developer Program set up for Clave Agent

Written 2026-09-22, from Apple's current enrolment, roles and certificate pages and from the
`notarytool` shipped with Xcode 27. This is what has to happen before anyone outside this machine can
open Clave Agent without a malware-style warning. Nothing here is about the App Store: the app is a
DMG people download. The membership is needed because it is the only source of the **Developer ID
Application** certificate and of **notarisation**, and those two are what make macOS trust a
downloaded app.

Everything in this file is done by a person. No agent ever handles an Apple password, an
app-specific password, an API key file, or a certificate; the build scripts only ever need two
*names* (see step 6).

## What the membership is and costs

- Apple Developer Program, **organisation** enrolment under TeamEx (the legal entity).
- **99 USD per year** (shown in local currency at checkout). One membership covers the whole team.
- Apple reviews organisation enrolments by hand. Plan for **several days, sometimes weeks**, and
  start now: nothing else in packaging can be finished before it.

## Step 1: what to ask your boss for

Apple only lets a person with **legal authority to bind the company** enrol an organisation. That
person becomes the **Account Holder**. So the first decision is who that is. Send your boss this
checklist (copy it as is):

> To publish the Clave desktop app for Mac we need an Apple Developer Program membership for the
> company (99 USD/year). Apple requires the enrolment to be done by someone with legal authority to
> sign for the company, who becomes the "Account Holder". I need from you:
>
> 1. **Who enrols.** Either you enrol (about 20 minutes, then you add me as Admin), or you confirm
>    in writing that I have authority to enrol on the company's behalf. Apple may ask for proof.
> 2. **The exact legal entity name** as registered (not a trade name or brand): what "TeamEx" is
>    legally called, and its registered address (no P.O. box) and phone number.
> 3. **Our D-U-N-S number** (a free nine-digit company identifier from Dun & Bradstreet). If we do
>    not have one, Apple's page lets us look it up or request it for free; that alone can take a
>    week or two, so it is the first thing to check.
> 4. **A company website** on our own domain that is public and has real content (a domain that only
>    redirects or shows a placeholder is refused).
> 5. **Which Apple Account (Apple ID) to use**: it must be a work email on the company domain, with
>    two-factor authentication on, and the person's real legal first and last name on it.
> 6. **A company card** for the 99 USD/year.
>
> Once the membership is approved, the Account Holder creates one certificate and one credential
> (steps 4 and 5 below, ten minutes), or grants me the Admin role so I can.

Where to find or request a D-U-N-S number: Apple's enrolment page links to the D&B lookup form;
requesting a new number through Apple's link is free.

## Step 2: enrol

1. On the Account Holder's Mac, sign in at https://developer.apple.com/programs/enroll/ with the
   work Apple Account (two-factor authentication must already be on).
2. Choose **Organization**, enter the legal entity name, the D-U-N-S number, the address, the
   phone number and the website exactly as registered.
3. Confirm the legal authority statement, agree to the Apple Developer Program License Agreement,
   pay the fee.
4. Wait for Apple's email. Apple sometimes phones the company or asks for documents; answer them
   promptly, the clock stops while they wait.

If you enrol instead of your boss, do it with the written authority from step 1 at hand.

## Step 3: add the people who need access

Only the Account Holder can add **Admins**. In https://developer.apple.com/account, under
**People**, the Account Holder invites you with the **Admin** role and, in the same screen, ticks
**Access to Certificates, Identifiers & Profiles**. That is what lets you create the certificate in
step 4 without going back to the Account Holder every time. (Apple's roles page: the Account Holder
and Admins can create Developer ID certificates and App Store Connect API keys; other roles cannot.)

## Step 4: create the Developer ID Application certificate (on your Mac)

The certificate must end up in the **login keychain of the Mac that builds the app**, this one.

1. Open **Keychain Access**, menu **Keychain Access > Certificate Assistant > Request a Certificate
   From a Certificate Authority**. Enter your work email, a name, choose **Saved to disk**. This
   writes a `.certSigningRequest` file and creates the private key in your login keychain.
2. In https://developer.apple.com/account/resources/certificates, click **+**, choose **Developer
   ID > Developer ID Application**, upload the request file, download the `.cer` file.
3. Double-click the `.cer` file. It lands in Keychain Access under **My Certificates**, next to its
   private key. Its name looks like `Developer ID Application: <legal entity name> (<TEAMID>)`.
4. Check it from a terminal (this prints names only):

   ```bash
   security find-identity -v -p codesigning
   ```

   The Developer ID line must say the certificate is valid. If it is listed as not trusted, the
   Apple intermediate certificate is missing; Xcode installs it, or download "Developer ID
   Certification Authority" from Apple's certificate authority page and double-click it.

Apple allows five Developer ID Application certificates per team. Make one and keep it; never
export or email its private key.

## Step 5: store the notarisation credential (on your Mac)

Notarisation is Apple scanning the app and issuing a ticket. The build script sends the app with a
credential that lives only in your keychain, under a **profile name**. Two ways; the first is better
because it can be revoked on its own without touching anyone's Apple ID:

**A. App Store Connect API key (recommended).** In https://appstoreconnect.apple.com/access/integrations/api,
the Account Holder or an Admin creates a **Team key** with the **Developer** role, downloads the
`.p8` file once (Apple never shows it again), and notes the **Key ID** and the **Issuer ID** shown
on that page. Then, on this Mac:

```bash
xcrun notarytool store-credentials clave-notary --key /path/to/AuthKey_XXXXXXXXXX.p8 --key-id XXXXXXXXXX --issuer 00000000-0000-0000-0000-000000000000
```

**B. Apple ID with an app-specific password.** Create the password at https://account.apple.com
under Sign-In and Security > App-Specific Passwords, then:

```bash
xcrun notarytool store-credentials clave-notary --apple-id you@teamex.example --team-id TEAMID
```

It prompts for the password securely; nothing is typed into a script. Both forms validate the
credential against Apple before saving it, so a typo fails here and not later.

After storing it, delete the `.p8` file from Downloads if you used A: the keychain has what it needs.

## Step 6: what to tell the packaging session

Exactly two names, nothing else:

1. the certificate's name as Keychain Access shows it, for example
   `Developer ID Application: TeamEx LLC (ABCDE12345)`;
2. the profile name from step 5, which is `clave-notary` if you kept the command above.

The scripts look both up in the keychain by name at run time. They never read, print or store the
password, the key file or the certificate.

## What happens next, for reference

- `pnpm --dir app package:sign -- --flavour internal --sign "<certificate name>"` signs the build
  under the Developer ID; then `pnpm --dir app package:artefacts -- --flavour internal --notarize
  clave-notary` notarises the app and the DMG, staples the tickets and runs Gatekeeper's own check.
- The first such build is where the remaining measurements happen (the entitlement ladder, the
  smaller bundle, and P1/P2/P6/P7 of the packaging design). Two people on other Macs can then open
  the DMG with no warning at all.
- Renewal is yearly; a lapsed membership does not break apps already notarised, but no new build
  can be notarised until it is renewed.

## Do not

- Do not enrol as an **individual** to save time: the seller name and the Gatekeeper dialog would
  show a person's name, and moving an app between two memberships later means every user's Screen
  Recording grant is reset.
- Do not use a trade name, a brand, or a branch as the legal entity: Apple refuses those.
- Do not paste any password, app-specific password, key file contents or certificate into a chat,
  a ticket, or the repository.
