# UIUC Auto Register

Watches the course sections you want and registers you the moment a seat opens.

## Setup

Install [Docker Desktop](https://www.docker.com/products/docker-desktop/) and open it. Then run this in a terminal:

```sh
docker run -d --name uiuc-auto-register --restart unless-stopped --cap-add=SYS_ADMIN -p 127.0.0.1:3000:3000 -v uiuc-auto-register:/data ghcr.io/halp1/uiuc-auto-register
```

Open http://localhost:3000. The setup walks you through the rest: your Illinois login, an authenticator key for the app, a test run, turning on Live, notifications, and your first schedule.

To run it on a server instead, see [Deploy on Coolify](#deploy-on-coolify).

To update later:

```sh
docker pull ghcr.io/halp1/uiuc-auto-register
docker rm -f uiuc-auto-register
```

Then run the `docker run` command again. Your settings and courses are kept in the `uiuc-auto-register` volume.

## Your login

The app logs in as you, so it needs your NetID, your password, and its own authenticator key. Setup shows you how to add that key to your Microsoft account. You can change any of them later in Settings, Account.

They are stored encrypted in the app's data folder. The key that unlocks them sits in the same folder, so anyone with the whole folder can read them. Keep it private.

## Modes

Change the mode in Settings, Registration. The app restarts its Banner connection when you switch.

| Mode | What happens |
|---|---|
| Live | Real registration, once you turn on Live for a term and type its name to confirm. This is the default. |
| Test | Logs into your real account and checks everything, but never adds or drops anything. |
| Simulated | Pretend Banner. Use the Simulator in Settings to open seats and watch the app react. |

Live can only be turned on within a day of a passing test for that term. Setup runs the first test for you. To run one again, open Settings, Test, and choose **Run test**. It shows each step, lists the classes you are already in, and confirms your CRNs exist. Check that the list matches your real schedule.

If registration for the term has not opened yet, the test still passes as long as Banner shows your time ticket (or you entered one in Settings). It then checks your schedule on a term that is open now, such as the current semester, and shows which one.

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

In Test and Live mode the app reads your time ticket from Banner's Prepare for Registration page every 12 hours and fills it in for you. **Check now** in Settings reads it right away. If you type a ticket yourself, automatic detection turns off until you switch it back on.

The app logs in 10 minutes before your ticket and tries to register right at the opening second. It never checks the ticket in the 30 minutes before it opens.

## Notifications

Setup asks you to pick at least one. You can add or change them later in Settings, Notifications, and choose which events go where.

**Discord DM.** A private message from your own bot, with Register and Skip buttons. The bot also answers `/status`, `/pause`, and `/resume`.

1. Create an application at https://discord.com/developers/applications.
2. Open **Bot**, choose **Reset Token**, and copy the token.
3. Open **OAuth2**, then **URL Generator**. Tick `bot` and `applications.commands`, open the link it makes, and add the bot to a server you are in. A new empty server works.
4. In Discord, turn on **Developer Mode** under Settings, Advanced. Right-click your own name and choose **Copy User ID**.
5. Paste the token and your user ID into the app and send a test.

**Discord channel.** Posts to one channel through a webhook. There is no bot to set up, but the messages have no buttons, so you answer approvals on the dashboard or in the bot DM.

1. In your server, open Server Settings, Integrations, Webhooks.
2. Choose **New Webhook**, pick the channel, and copy the webhook URL.
3. Paste it into the app and send a test.

Anyone with the webhook URL can post in that channel, so keep it private.

**Browser.** Choose Enable and allow notifications. On iPhone, add the site to your Home Screen first.

## Your schedule is protected

- Nothing real happens unless the mode is Live **and** you turn on Live for that exact term.
- The app only ever adds the sections in the bundle it is registering.
- After every registration it rereads your schedule. If anything else is missing, it stops everything and alerts you.
- Swapping one course for another is locked. It can only be unlocked by testing it on a Winter or Summer term first.

## Using Banner yourself

You can use Banner in your own browser while the app is running. Logging in yourself does not sign the app out.

Avoid dropping classes yourself while the app is armed for the same term. The app compares your schedule with its last check before every registration, and a class that disappeared without it will stop it and alert you. Run a test afterward to refresh what it expects. If you plan to make changes by hand, choose **Pause all** in the top bar first.

## Deploy on Coolify

1. Create a new resource from this repository using the Dockerfile.
2. Add a persistent volume mounted at `/data`.
3. Under Configuration, General, Custom Docker Options, add `--cap-add=SYS_ADMIN`. Chrome inside the container needs it.
4. Expose port 3000 and put the domain behind Cloudflare Access. The app has no login of its own, and anyone who can open it can see and change your settings.
5. Open the domain and follow the setup.

## Run without Docker

You need [Bun](https://bun.com) and Google Chrome.

```sh
bun install
bun start
```

Open http://localhost:3000. Data goes in `./data`. `bun start --port 4000 --data ~/uiuc-data` changes either one.

`bun dev` reloads on code changes. Live registration can't be turned on while it runs, so use `bun start` for the real thing.

## Optional checks

These always run in Test mode, so they only read, and they use the login saved in `./data` (add `--data <folder>` for another one).

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

## Maintainers

Pushing to `main` builds `ghcr.io/halp1/uiuc-auto-register` for amd64 and arm64. After the first build, set the package to public in its GitHub package settings so `docker run` works without logging in.
