# VOX ticket watcher

This read-only checker scans the VOX Cinemas Egypt showtimes exposed for City Centre Almaza, then inspects the booking seat map without selecting or purchasing anything.

It checks every date currently exposed by the VOX showtimes page and only follows showtimes starting at or after 7:00pm.

## Current preferences

- Spider-Man: Brand New Day, GOLD, preferred pairs `C-6 + C-5` or `C-4 + C-3`.
- The Odyssey, IMAX, preferred pairs `E-16 + E-15`, `F-16 + F-15`, `G-16 + G-15`, `H-16 + H-15`, or `I-16 + I-15`.
- Cinema: City Centre Almaza.

The seat groups live in `src/config.mjs` so they can be updated without changing the checker logic.

## Telegram setup

1. In Telegram, open `@BotFather`, use `/newbot`, and copy the bot token.
2. Start a chat with the new bot and send it a message such as `hello`.
3. Find the chat ID for that conversation. One simple method is to open this URL in a browser, replacing `BOT_TOKEN` with the token:

   `https://api.telegram.org/botBOT_TOKEN/getUpdates`

   Copy the `message.chat.id` value from the response.
4. Add these as GitHub Actions repository secrets:

   - `TELEGRAM_BOT_TOKEN`
   - `TELEGRAM_CHAT_ID`

The checker sends a quiet blue `VOX CHECK COMPLETED` message after every run. When one or more preferred pairs are available, it also sends a separate audible `VOX SEATS AVAILABLE` alert with the booking link. Availability alerts repeat while a preferred pair remains available, so a short-lived opening is harder to miss.

## Hosting limitation

The complete booking flow works locally in headed Google Chrome. GitHub-hosted headed Chrome under Xvfb is still experimental because the runner uses Linux and a datacenter network. Scheduled checks remain paused until repeated manual workflow runs confirm that seat maps load reliably.

## Local run

```bash
npm install
npx playwright install chromium
DRY_RUN=1 npm run check
```

`DRY_RUN=1` prints both Telegram messages instead of sending them. A real run requires `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` in the environment.

VOX currently rejects the automated Chromium connection in headless mode. On a Mac with Google Chrome installed, use visible Chrome for local checks:

```bash
BROWSER_CHANNEL=chrome HEADLESS=0 DRY_RUN=1 npm run check
```

The Chrome window must remain available while the check runs. `BROWSER_USER_AGENT` can optionally override Chrome's normal user-agent, but the default local configuration uses Chrome's own user-agent.

For faster debugging, use `CHECK_TARGET` with a target ID from `src/config.mjs` and `CHECK_LIMIT` to inspect only the first matching showtimes:

```bash
CHECK_TARGET=the-odyssey-imax CHECK_LIMIT=2 BROWSER_CHANNEL=chrome HEADLESS=1 DRY_RUN=1 npm run check
```

The output identifies this as a limited probe. Runs without these variables still inspect every eligible showtime.

## GitHub Actions

The workflow currently runs manually from the Actions tab. Its defaults perform a dry two-showtime Odyssey IMAX probe, so no Telegram message is sent. Disable **Check only two Odyssey IMAX showtimes** for a complete run, and disable **Print Telegram messages without sending them** only after configuring the Telegram repository secrets.

Scheduled checks will be enabled after the GitHub-hosted headed-browser flow passes repeated complete runs.
