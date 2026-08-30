import { chromium } from "playwright";
import {
  cairoDateKey,
  CONFIG,
  formatCairoNow,
  formatDateKey,
  parseTimeToMinutes,
  showtimesUrl,
  urlForDate,
} from "./config.mjs";

const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS ?? 35_000);
const BOOKING_TIMEOUT_MS = Number(process.env.BOOKING_TIMEOUT_MS ?? 45_000);
const BOOKING_ATTEMPTS = Number(process.env.BOOKING_ATTEMPTS ?? 2);
const GUEST_SETTLE_MS = Number(process.env.GUEST_SETTLE_MS ?? 5_000);
const DRY_RUN = process.env.DRY_RUN === "1";
const HEADLESS = process.env.HEADLESS !== "0";
const BROWSER_CHANNEL = process.env.BROWSER_CHANNEL?.trim() || undefined;
const BROWSER_USER_AGENT =
  process.env.BROWSER_USER_AGENT?.trim() || undefined;
const CHECK_TARGET = process.env.CHECK_TARGET?.trim() || undefined;
const CHECK_LIMIT = parseCheckLimit(process.env.CHECK_LIMIT);
const LIMITED_PROBE = Boolean(CHECK_TARGET || CHECK_LIMIT);
const FETCH_USER_AGENT =
  BROWSER_USER_AGENT ??
  "vox-ticket-watcher/1.0 (+read-only availability monitoring; no automated booking)";

function browserLaunchOptions() {
  return {
    headless: HEADLESS,
    args: [
      "--disable-blink-features=AutomationControlled",
      "--disable-dev-shm-usage",
    ],
    ignoreDefaultArgs: ["--enable-automation"],
    ...(BROWSER_CHANNEL ? { channel: BROWSER_CHANNEL } : {}),
  };
}

function browserContextOptions() {
  return {
    locale: "en-US",
    timezoneId: CONFIG.timeZone,
    ...(BROWSER_USER_AGENT ? { userAgent: BROWSER_USER_AGENT } : {}),
  };
}

async function createBrowserContext(browser) {
  const context = await browser.newContext(browserContextOptions());
  await context.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, "webdriver", {
      configurable: true,
      get: () => undefined,
    });
  });
  return context;
}

function normalize(value) {
  return value.trim().replace(/\s+/g, " ").toUpperCase();
}

function parseCheckLimit(value) {
  if (value === undefined || value.trim() === "") {
    return undefined;
  }

  const limit = Number(value);
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error("CHECK_LIMIT must be a positive integer");
  }

  return limit;
}

function hasMovie(movie, target) {
  if (movie.slug === target.movieSlug) {
    return true;
  }

  const title = normalize(movie.title);
  return target.id === "spider-man-gold"
    ? title.includes("SPIDER-MAN")
    : title.includes("THE ODYSSEY");
}

function hasFormat(format, target) {
  return normalize(format) === normalize(target.format);
}

function isEligibleShowtime(timeText) {
  const minutes = parseTimeToMinutes(timeText);
  return Number.isFinite(minutes) && minutes >= CONFIG.earliestStartMinutes;
}

function urlString(value) {
  return new URL(value, CONFIG.origin).href;
}

async function waitForMovieCards(page) {
  await page.waitForSelector("article.movie-compare", {
    state: "attached",
    timeout: REQUEST_TIMEOUT_MS,
  });
}

function isTransportNavigationError(error) {
  return /ERR_HTTP2_PROTOCOL_ERROR|ERR_CONNECTION_RESET|ERR_NETWORK_CHANGED/i.test(
    error instanceof Error ? error.message : String(error),
  );
}

function addBaseHref(html, url) {
  const escapedUrl = url
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;");
  const baseTag = `<base href="${escapedUrl}">`;
  return /<head\b[^>]*>/i.test(html)
    ? html.replace(/<head\b[^>]*>/i, (head) => `${head}${baseTag}`)
    : `${baseTag}${html}`;
}

async function loadPageWithNodeFetch(page, url) {
  const response = await fetch(url, {
    headers: {
      accept: "text/html,application/xhtml+xml",
      "user-agent": FETCH_USER_AGENT,
    },
    redirect: "follow",
  });

  if (!response.ok) {
    throw new Error(`VOX returned HTTP ${response.status} for ${url}`);
  }

  const html = await response.text();
  await page.setContent(addBaseHref(html, url), {
    waitUntil: "domcontentloaded",
    timeout: REQUEST_TIMEOUT_MS,
  });
}

async function openShowtimesPage(page, url) {
  try {
    await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: REQUEST_TIMEOUT_MS,
    });
  } catch (error) {
    if (!isTransportNavigationError(error)) {
      throw error;
    }

    // Some hosted runners intermittently fail Chromium's HTTP/2 connection
    // to VOX. Node's fetch client can retrieve the same public HTML, so use
    // it once as a transport fallback without changing the read-only flow.
    await loadPageWithNodeFetch(page, url);
  }

  await waitForMovieCards(page);
}

function isPageCrashError(error) {
  return /Page crashed|Target page, context or browser has been closed/i.test(
    error instanceof Error ? error.message : String(error),
  );
}

function collectListingDiagnostics(page) {
  const events = [];
  let crashed = false;
  const add = (message) => {
    events.push(message);
    if (events.length > 8) {
      events.shift();
    }
  };

  page.on("crash", () => {
    crashed = true;
    add("PAGE CRASHED");
  });
  page.on("response", (response) => {
    if (response.request().resourceType() === "document") {
      add(`HTTP ${response.status()} ${bookingPath(response.url())}`);
    }
  });
  page.on("requestfailed", (request) => {
    if (request.resourceType() === "document") {
      add(
        `FAILED ${bookingPath(request.url())}: ${
          request.failure()?.errorText ?? "unknown network error"
        }`,
      );
    }
  });
  page.on("pageerror", (error) => add(`PAGE ERROR: ${errorMessage(error)}`));

  return {
    didCrash: () => crashed,
    summary: () => events.join("; "),
  };
}

async function withFreshListingPage(context, action) {
  const maxAttempts = 2;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const page = await context.newPage();
    const diagnostics = collectListingDiagnostics(page);

    try {
      return await action(page);
    } catch (error) {
      const crashed = diagnostics.didCrash() || isPageCrashError(error);
      if (crashed && attempt < maxAttempts) {
        console.warn("VOX listing page crashed; retrying with a fresh page");
        continue;
      }

      const summary = diagnostics.summary();
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        summary ? `Listing network: ${summary}. ${message}` : message,
        { cause: error },
      );
    } finally {
      await page.close().catch(() => {});
    }
  }

  throw new Error("VOX listing page retry unexpectedly exhausted");
}

async function discoverDatePages(context, todayKey) {
  const baseUrl = showtimesUrl();
  const hrefs = await withFreshListingPage(context, async (page) => {
    await openShowtimesPage(page, baseUrl.href);
    return page.locator("a[href]").evaluateAll((anchors) =>
      anchors.map((anchor) => anchor.href),
    );
  });
  const dateKeys = new Set([todayKey]);

  for (const href of hrefs) {
    try {
      const url = new URL(href, baseUrl);
      const dateKey = url.searchParams.get("d");
      if (/^\d{8}$/.test(dateKey ?? "")) {
        dateKeys.add(dateKey);
      }
    } catch {
      // Ignore malformed or unrelated links on the page.
    }
  }

  return [...dateKeys]
    .sort()
    .map((dateKey) => ({
      dateKey,
      label: formatDateKey(dateKey),
      url: urlForDate(dateKey, todayKey).href,
    }));
}

async function extractMovieShowtimes(page) {
  return page.locator("article.movie-compare").evaluateAll((articles) =>
    articles.map((article) => {
      const title = article.querySelector("h2")?.textContent?.trim() ?? "";
      const slug = article.getAttribute("data-slug") ?? "";
      const formatGroups = [...article.querySelectorAll("ol.showtimes > li")].map(
        (formatGroup) => ({
          format: formatGroup.querySelector("strong")?.textContent?.trim() ?? "",
          showtimes: [
            ...formatGroup.querySelectorAll("a.action.showtime"),
          ].map((anchor) => ({
            timeText: anchor.textContent?.trim() ?? "",
            href: anchor.href,
            id:
              anchor.getAttribute("data-id") ??
              anchor.closest("li")?.getAttribute("data-id") ??
              "",
          })),
        }),
      );

      return { title, slug, formatGroups };
    }),
  );
}

async function collectEligibleShowtimes(context, dates) {
  const eligible = [];
  const errors = [];

  for (const date of dates) {
    try {
      const movies = await withFreshListingPage(context, async (page) => {
        await openShowtimesPage(page, date.url);
        return extractMovieShowtimes(page);
      });

      for (const target of CONFIG.targets) {
        const movie = movies.find((candidate) => hasMovie(candidate, target));
        if (!movie) {
          continue;
        }

        for (const formatGroup of movie.formatGroups) {
          if (!hasFormat(formatGroup.format, target)) {
            continue;
          }

          for (const showtime of formatGroup.showtimes) {
            if (!isEligibleShowtime(showtime.timeText)) {
              continue;
            }

            eligible.push({
              target,
              dateKey: date.dateKey,
              dateLabel: date.label,
              sourceUrl: date.url,
              movieTitle: movie.title || target.movieName,
              format: formatGroup.format,
              timeText: showtime.timeText,
              timeMinutes: parseTimeToMinutes(showtime.timeText),
              bookingUrl: urlString(showtime.href),
              showtimeId: showtime.id,
            });
          }
        }
      }
    } catch (error) {
      errors.push({
        stage: "showtimes",
        date: date.label,
        message: errorMessage(error),
      });
    }
  }

  eligible.sort((a, b) =>
    a.dateKey.localeCompare(b.dateKey) ||
    a.target.id.localeCompare(b.target.id) ||
    a.timeMinutes - b.timeMinutes,
  );

  return { eligible, errors };
}

function filterEligibleShowtimes(eligible) {
  let filtered = eligible;

  if (CHECK_TARGET) {
    if (!CONFIG.targets.some((target) => target.id === CHECK_TARGET)) {
      throw new Error(`Unknown CHECK_TARGET: ${CHECK_TARGET}`);
    }
    filtered = filtered.filter(
      (showtime) => showtime.target.id === CHECK_TARGET,
    );
  }

  return CHECK_LIMIT ? filtered.slice(0, CHECK_LIMIT) : filtered;
}

const BOOKING_STATE = Object.freeze({
  guest: "guest",
  processing: "processing",
  consent: "consent",
  seats: "seats",
});

async function waitForBookingState(page, ignoredState, timeout) {
  const handle = await page.waitForFunction(
    ({ states, ignored }) => {
      const isVisible = (element) => {
        const style = window.getComputedStyle(element);
        const bounds = element.getBoundingClientRect();
        return (
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          Number(style.opacity) !== 0 &&
          bounds.width > 0 &&
          bounds.height > 0
        );
      };
      const hasVisibleControl = (pattern) =>
        [...document.querySelectorAll("a, button")].some(
          (element) =>
            isVisible(element) && pattern.test(element.textContent?.trim() ?? ""),
        );

      let state = null;
      if (hasVisibleControl(/^I\s+Agree$/i)) {
        state = states.consent;
      } else if (
        /Retrieving\s+Seating\s+Plan/i.test(document.body?.innerText ?? "") ||
        window.location.pathname.endsWith("/processing")
      ) {
        state = states.processing;
      } else if (hasVisibleControl(/^Continue\s+as\s+Guest$/i)) {
        state = states.guest;
      } else if (document.querySelector('input[name="seat"]')) {
        state = states.seats;
      }

      return state && state !== ignored ? state : null;
    },
    { states: BOOKING_STATE, ignored: ignoredState },
    { timeout },
  );

  return handle.jsonValue();
}

async function clickVisibleBookingControl(page, text) {
  const controls = page.locator("a, button").filter({ hasText: text });
  const count = await controls.count();

  for (let index = 0; index < count; index += 1) {
    const control = controls.nth(index);
    if (await control.isVisible()) {
      await control.click({ timeout: BOOKING_TIMEOUT_MS });
      return;
    }
  }

  throw new Error(`Booking control disappeared before it could be clicked: ${text}`);
}

async function driveBookingToSeats(page) {
  const deadline = Date.now() + BOOKING_TIMEOUT_MS;
  const transitions = [];
  let consentAccepted = false;
  let ignoredState = null;

  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    let state;
    try {
      state = await waitForBookingState(page, ignoredState, remaining);
    } catch (error) {
      const observed = transitions.length > 0 ? transitions.join(" -> ") : "none";
      throw new Error(
        `Booking did not reach the seat map. Observed states: ${observed}. Final URL: ${bookingPath(page.url())}`,
        { cause: error },
      );
    }

    transitions.push(state);
    if (state === BOOKING_STATE.seats) {
      if (consentAccepted) {
        return transitions;
      }

      // VOX inserts the seat inputs shortly before displaying its mandatory
      // conditions modal. Do not treat that early DOM as a completed flow.
      ignoredState = state;
      continue;
    }

    if (state === BOOKING_STATE.guest) {
      // Give VOX time to finish initializing the generated booking session
      // before requesting its seat plan, matching the reliable manual flow.
      await page.waitForTimeout(GUEST_SETTLE_MS);
      await clickVisibleBookingControl(page, /^Continue\s+as\s+Guest$/i);
    } else if (state === BOOKING_STATE.consent) {
      await clickVisibleBookingControl(page, /^I\s+Agree$/i);
      consentAccepted = true;
    }

    ignoredState = state;
  }

  throw new Error(
    `Booking state deadline expired. Observed states: ${transitions.join(" -> ")}`,
  );
}

async function readSeatLabels(page) {
  const seats = page.locator('input[name="seat"]');
  await seats.first().waitFor({
    state: "attached",
    timeout: BOOKING_TIMEOUT_MS,
  });

  const records = await seats.evaluateAll((inputs) =>
    inputs
      .map((input) => ({
        label: (
          input.getAttribute("data-label") ??
          input.getAttribute("value") ??
          ""
        ).trim(),
        available: !input.disabled,
      }))
      .filter(({ label }) => label.length > 0),
  );

  if (records.length === 0) {
    throw new Error("The booking page returned no labelled seats");
  }

  return records;
}

function bookingPath(value) {
  try {
    const url = new URL(value);
    return `${url.pathname}${url.search}`;
  } catch {
    return value;
  }
}

function collectBookingNetworkDiagnostics(page) {
  const events = [];
  const add = (message) => {
    events.push(message);
    if (events.length > 8) {
      events.shift();
    }
  };

  page.on("response", (response) => {
    const request = response.request();
    if (
      request.resourceType() === "document" &&
      response.frame() === page.mainFrame()
    ) {
      add(`HTTP ${response.status()} ${bookingPath(response.url())}`);
    }
  });

  page.on("requestfailed", (request) => {
    if (
      request.resourceType() === "document" &&
      request.frame() === page.mainFrame()
    ) {
      add(
        `FAILED ${bookingPath(request.url())}: ${
          request.failure()?.errorText ?? "unknown network error"
        }`,
      );
    }
  });

  return () => events.join("; ");
}

function showtimeDescription(showtime) {
  return `${showtime.dateLabel} | ${showtime.target.movieName} | ${showtime.timeText}`;
}

async function findBookingLink(page, showtime) {
  const links = page.locator("a.action.showtime");
  const hrefs = await links.evaluateAll((anchors) =>
    anchors.map((anchor) => anchor.href),
  );
  const targetPath = bookingPath(showtime.bookingUrl);
  const index = hrefs.findIndex((href) => bookingPath(href) === targetPath);

  if (index < 0) {
    throw new Error(`Showtime link disappeared from ${bookingPath(showtime.sourceUrl)}`);
  }

  return links.nth(index);
}

function isBookingUrl(url) {
  return url.origin === CONFIG.origin && url.pathname.startsWith("/booking/");
}

async function clickShowtimeAndGetBookingPage(context, showtimesPage, link) {
  const destination = Promise.any([
    context.waitForEvent("page", { timeout: BOOKING_TIMEOUT_MS }),
    showtimesPage
      .waitForURL(isBookingUrl, {
        waitUntil: "commit",
        timeout: BOOKING_TIMEOUT_MS,
      })
      .then(() => showtimesPage),
  ]);

  await link.click({ noWaitAfter: true, timeout: BOOKING_TIMEOUT_MS });
  const bookingPage = await destination;
  await bookingPage.waitForURL(isBookingUrl, {
    waitUntil: "commit",
    timeout: BOOKING_TIMEOUT_MS,
  });
  return bookingPage;
}

async function readBookingSeatLabels(showtime) {
  const attemptErrors = [];

  for (let attempt = 1; attempt <= BOOKING_ATTEMPTS; attempt += 1) {
    let browser;
    let context;
    let networkSummary = () => "";

    try {
      // A new context isolates cookies, but Chromium still reuses the browser's
      // HTTP/2 connection pool. Launching a fresh process also resets the
      // transport state that VOX intermittently leaves stalled.
      browser = await chromium.launch(browserLaunchOptions());
      context = await createBrowserContext(browser);
      const showtimesPage = await context.newPage();
      const networkSummaries = [collectBookingNetworkDiagnostics(showtimesPage)];
      networkSummary = () =>
        networkSummaries.map((summary) => summary()).filter(Boolean).join("; ");

      await openShowtimesPage(showtimesPage, showtime.sourceUrl);
      const bookingLink = await findBookingLink(showtimesPage, showtime);
      await bookingLink.waitFor({ state: "visible", timeout: REQUEST_TIMEOUT_MS });
      const bookingPage = await clickShowtimeAndGetBookingPage(
        context,
        showtimesPage,
        bookingLink,
      );
      if (bookingPage !== showtimesPage) {
        networkSummaries.push(collectBookingNetworkDiagnostics(bookingPage));
      }
      const transitions = await driveBookingToSeats(bookingPage);
      const seats = await readSeatLabels(bookingPage);
      console.log(
        `[booking] ${showtimeDescription(showtime)} | ${transitions.join(" -> ")} | ${seats.length} seats`,
      );
      return seats;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const summary = networkSummary();
      const detail = summary ? `${message}. Booking network: ${summary}` : message;
      attemptErrors.push(`attempt ${attempt}: ${detail}`);
      console.warn(
        `[booking] ${showtimeDescription(showtime)} | attempt ${attempt} failed: ${errorMessage(detail)}`,
      );

      if (attempt < BOOKING_ATTEMPTS) {
        console.warn(
          `[booking] ${showtimeDescription(showtime)} | retrying in a clean browser`,
        );
      }
    } finally {
      if (context) {
        await context.close().catch(() => {});
      }
      if (browser) {
        await browser.close().catch(() => {});
      }
    }
  }

  throw new Error(attemptErrors.join(" | "));
}

async function checkSeats(showtime) {
  const seats = await readBookingSeatLabels(showtime);
  const availableLabels = new Set(
    seats.filter((seat) => seat.available).map((seat) => seat.label),
  );
  const availablePairs = showtime.target.seatGroups.filter((pair) =>
    pair.every((label) => availableLabels.has(label)),
  );

  return {
    ...showtime,
    status: "ok",
    seatCount: seats.length,
    availablePairs,
  };
}

function errorMessage(error) {
  if (error instanceof Error) {
    return error.message.replace(/\s+/g, " ").slice(0, 800);
  }
  return String(error).replace(/\s+/g, " ").slice(0, 800);
}

async function inspectEligibleShowtimes(eligible, initialErrors) {
  const results = [];
  const errors = [...initialErrors];
  for (const showtime of eligible) {
    try {
      results.push(await checkSeats(showtime));
    } catch (error) {
      errors.push({
        stage: "seats",
        date: showtime.dateLabel,
        movie: showtime.target.movieName,
        time: showtime.timeText,
        message: errorMessage(error),
      });
    }
  }

  return { results, errors };
}

function resultsForTarget(report, targetId) {
  return report.results.filter((result) => result.target.id === targetId);
}

function resultLine(result) {
  const pairs = result.availablePairs.length
    ? `MATCH ${result.availablePairs.map((pair) => pair.join(" + ")).join(", ")}`
    : "no preferred pair";
  return `- ${result.dateLabel} | ${result.timeText} | ${pairs}`;
}

function buildHeartbeat(report) {
  const lines = [
    LIMITED_PROBE ? "🧪 VOX LIMITED PROBE COMPLETED" : "🔵 VOX CHECK COMPLETED",
    `${formatCairoNow()} | ${CONFIG.cinema}`,
    `Dates scanned: ${report.dates.length}`,
    `Eligible showtimes checked: ${report.results.length}/${report.eligible.length}`,
  ];

  if (LIMITED_PROBE) {
    const filters = [
      CHECK_TARGET ? `target=${CHECK_TARGET}` : null,
      CHECK_LIMIT ? `limit=${CHECK_LIMIT}` : null,
    ].filter(Boolean);
    lines.push(`Probe filter: ${filters.join(", ")}`);
    lines.push(
      `Eligible showtimes selected: ${report.eligible.length}/${report.discoveredEligible}`,
    );
  }
  lines.push("");

  const displayedTargets = CHECK_TARGET
    ? CONFIG.targets.filter((target) => target.id === CHECK_TARGET)
    : CONFIG.targets;
  for (const target of displayedTargets) {
    lines.push(`${target.movieName} - ${target.format}`);
    const targetResults = resultsForTarget(report, target.id);
    const targetEligible = report.eligible.filter(
      (showtime) => showtime.target.id === target.id,
    );
    if (targetResults.length > 0) {
      lines.push(...targetResults.map(resultLine));
    } else if (targetEligible.length > 0) {
      lines.push("- Eligible showtimes found, but no seat results returned");
    } else if (report.dates.length === 0) {
      lines.push("- No result - showtimes page was not scanned");
    } else {
      lines.push("- No showtimes at or after 7:00pm found");
    }
    lines.push("");
  }

  if (report.errors.length > 0) {
    lines.push(`⚠️ Partial check: ${report.errors.length} issue(s)`);
    for (const issue of report.errors.slice(0, 5)) {
      const context = [issue.stage, issue.date, issue.movie, issue.time]
        .filter(Boolean)
        .join(" | ");
      lines.push(`- ${context}: ${issue.message}`);
    }
  } else {
    lines.push("Status: complete");
  }

  return clipTelegramMessage(lines.join("\n"));
}

function buildAvailabilityAlert(report) {
  const matches = report.results.filter(
    (result) => result.availablePairs.length > 0,
  );
  if (matches.length === 0) {
    return null;
  }

  const lines = [
    LIMITED_PROBE
      ? "🚨 VOX SEATS AVAILABLE (LIMITED PROBE)"
      : "🚨 VOX SEATS AVAILABLE",
    `${formatCairoNow()} | ${CONFIG.cinema}`,
    "",
  ];

  for (const result of matches) {
    lines.push(`${result.target.movieName} - ${result.target.format}`);
    lines.push(`${result.dateLabel} | ${result.timeText}`);
    lines.push(
      `Preferred pair(s): ${result.availablePairs
        .map((pair) => pair.join(" + "))
        .join(", ")}`,
    );
    lines.push(result.bookingUrl);
    lines.push("");
  }

  lines.push("Open the booking link manually to review and purchase.");
  return clipTelegramMessage(lines.join("\n"));
}

function clipTelegramMessage(message) {
  const maxLength = 3900;
  return message.length <= maxLength
    ? message
    : `${message.slice(0, maxLength - 40)}\n...message shortened`;
}

async function sendTelegram(message, { silent }) {
  if (DRY_RUN) {
    console.log(`\n--- Telegram ${silent ? "heartbeat" : "availability"} ---\n${message}`);
    return;
  }

  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    throw new Error(
      "TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID must be configured (or use DRY_RUN=1)",
    );
  }

  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: message,
      disable_notification: silent,
      disable_web_page_preview: true,
    }),
  });

  if (!response.ok) {
    throw new Error(`Telegram returned HTTP ${response.status}`);
  }

  const payload = await response.json();
  if (!payload.ok) {
    throw new Error("Telegram rejected the message");
  }
}

async function main() {
  const todayKey = cairoDateKey();
  let listingBrowser;
  let listingContext;
  let report = {
    dates: [],
    eligible: [],
    discoveredEligible: 0,
    results: [],
    errors: [],
  };

  try {
    listingBrowser = await chromium.launch(browserLaunchOptions());
    listingContext = await createBrowserContext(listingBrowser);
    const dates = await discoverDatePages(listingContext, todayKey);
    const { eligible, errors: showtimeErrors } =
      await collectEligibleShowtimes(listingContext, dates);
    const selectedShowtimes = filterEligibleShowtimes(eligible);

    await listingContext.close();
    listingContext = undefined;
    await listingBrowser.close();
    listingBrowser = undefined;

    const { results, errors: seatErrors } = await inspectEligibleShowtimes(
      selectedShowtimes,
      showtimeErrors,
    );

    report = {
      dates,
      eligible: selectedShowtimes,
      discoveredEligible: eligible.length,
      results,
      errors: seatErrors,
    };
  } catch (error) {
    report.errors.push({ stage: "run", message: errorMessage(error) });
  } finally {
    if (listingContext) {
      await listingContext.close();
    }
    if (listingBrowser) {
      await listingBrowser.close();
    }
  }

  const heartbeat = buildHeartbeat(report);
  const alert = buildAvailabilityAlert(report);

  if (report.errors.length > 0) {
    console.error("VOX checker issues:");
    console.error(JSON.stringify(report.errors, null, 2));
  }

  await sendTelegram(heartbeat, { silent: true });
  if (alert) {
    await sendTelegram(alert, { silent: false });
  }

  console.log(
    JSON.stringify(
      {
        datesScanned: report.dates.length,
        eligibleShowtimes: report.eligible.length,
        discoveredEligibleShowtimes: report.discoveredEligible,
        checkedShowtimes: report.results.length,
        matches: report.results.filter((result) => result.availablePairs.length)
          .length,
        errors: report.errors.length,
        dryRun: DRY_RUN,
        browserChannel: BROWSER_CHANNEL ?? "bundled-chromium",
        browserMode: HEADLESS ? "headless" : "headed",
        limitedProbe: LIMITED_PROBE,
      },
      null,
      2,
    ),
  );

  if (report.errors.length > 0) {
    process.exitCode = 1;
  }
}

await main();
