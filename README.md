# UIUC Auto Register

Watches the course sections you want and registers you the moment a seat opens.

## Get started

You need [Bun](https://bun.com) and Google Chrome.

```sh
bun install
cp .env.example .env
bun dev
```

Open http://localhost:3000.

The app starts in **Simulated** mode. Nothing real happens: seat counts and registrations come from a pretend Banner, so you can try everything safely.

## Add your login

Open `.env` and fill in the same values you use for uiuc-totp:

```
UIUC_NETID=yournetid
UIUC_PASSWORD=yourpassword
UIUC_TOTP_SECRET=yourtotpsecret
```

These stay in `.env` only. The website never shows or stores them.

## The three modes

Set `REGISTRATION_MODE` in `.env`, then restart.

| Mode | What happens |
|---|---|
| `simulated` | Pretend Banner. Use the Simulator in Settings to open seats and watch the app react. |
| `rehearsal` | Logs into your real account and checks everything, but never adds or drops anything. |
| `live` | Real registration. You still have to turn on Live in Settings and type the term name to confirm. |

Run a rehearsal before going live: Settings, Rehearsal, Run rehearsal. It shows each step, lists the classes you are already in, and confirms your CRNs exist. Check that the list of classes matches your real schedule. Live can only be turned on within a day of a passing rehearsal for that term.

## Watch a course

1. Pick your term in the top bar.
2. Search for a course by code, title, instructor, or CRN.
3. On the course page, select the sections you need together (for example a lecture and its lab) and choose **Add bundle**. Add more bundles in the order you prefer them.
4. Or turn on **Any valid combination** and exclude days, times, or instructors you want to avoid.
5. Turn on **Arm**.

The app checks seats every 10 seconds. When every section in a bundle has a seat, it registers that bundle. Your first choice wins if several are open.

## Plan a schedule

1. Open **Plan** in the sidebar and add the courses you want to take.
2. Add breaks for times you want free, for example MWF 12:00 to 1:00 PM.
3. Choose **Generate**. Every schedule listed includes each course's required sections (lecture plus lab or discussion) with no time clashes, around the classes you are already in.
4. Move through the list with the arrow keys to preview each week. Press P to pin one and compare it with another.
5. Choose **Target this schedule**. Those courses go on your watchlist, armed, with your chosen sections first and backup sections that still fit your week after them.

Use the menu on a course to skip sections, lock one exact combination, or turn backups off. You can keep several named plans per term.

## Auto or approve

In Settings, Registration:

- **Auto** registers as soon as a bundle opens.
- **Approve** asks you first, on the dashboard, in Discord, or as a browser notification. You can also have it register on its own if you do not answer within a set number of minutes.

## Time ticket

In rehearsal and live mode the app reads your time ticket from Banner's Prepare for Registration page every 12 hours and fills it in for you. **Check now** in Settings reads it right away. If you type a ticket yourself, automatic detection turns off until you switch it back on.

The app logs in 10 minutes before your ticket and tries to register right at the opening second. It never checks the ticket in the 30 minutes before it opens.

## Notifications

Everything is off until you turn it on in Settings, Notifications.

**Discord**

1. Create a bot at https://discord.com/developers/applications and copy its token.
2. Invite the bot to a server you are in (it can only message you if you share a server).
3. Paste the token and your Discord user ID in Settings and send a test.

You get a direct message with Register and Skip buttons. The bot also answers `/status`, `/pause`, and `/resume`.

**Browser push**

Choose Enable in Settings and allow notifications. On iPhone, add the site to your Home Screen first.

Then pick which events go to which channel.

## Your schedule is protected

- Nothing real happens unless `.env` says `live` **and** you turn on Live in Settings for that exact term.
- The app only ever adds the sections in the bundle it is registering.
- After every registration it rereads your schedule. If anything else is missing, it stops everything and alerts you.
- Swapping one course for another is locked. It can only be unlocked by testing it on a Winter or Summer term first.

## Using Banner yourself

You can use Banner in your own browser while the app is running. Logging in yourself does not sign the app out.

Avoid dropping classes yourself while the app is armed for the same term. The app compares your schedule with its last check before every registration, and a class that disappeared without it will stop it and alert you. Run a rehearsal afterward to refresh what it expects. If you plan to make changes by hand, choose **Pause 30 min** under Session on the dashboard first.

## Deploy on Coolify

1. Create a new resource from this repository using the Dockerfile.
2. Add a persistent volume mounted at `/data`.
3. Add `UIUC_NETID`, `UIUC_PASSWORD`, `UIUC_TOTP_SECRET`, and `REGISTRATION_MODE` as secret environment variables.
4. Expose port 3000 and put the domain behind Cloudflare Access. The app has no login of its own.

If Chromium will not start, add `--cap-add=SYS_ADMIN` under Custom Docker Options and redeploy.

## Optional checks

Run these yourself with `REGISTRATION_MODE=rehearsal`. They only read.

```sh
bun run smoke:anon 59777        # live seat count for one CRN, no login
bun run probe:discover          # records how your registration page loads your schedule
bun run probe:sessions          # checks whether logging into Banner yourself logs the app out
bun run probe:ticket 120271     # shows the time ticket the app reads for a term
```

## Run the tests

```sh
bun test
```
