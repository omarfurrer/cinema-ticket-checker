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

The GitHub-hosted runner can discover VOX dates and showtimes, but VOX's booking seat-map request currently does not complete reliably from that runner. Until the checker is moved to a computer or self-hosted runner where the booking flow loads normally, Telegram heartbeats may report a partial check and seat-availability alerts should not be relied on.

## Local run

```bash
npm install
npx playwright install chromium
DRY_RUN=1 npm run check
```

`DRY_RUN=1` prints both Telegram messages instead of sending them. A real run requires `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` in the environment.

## GitHub Actions

The workflow runs on a five-minute schedule and can also be started manually from the Actions tab. GitHub may delay scheduled jobs briefly during periods of high load.
