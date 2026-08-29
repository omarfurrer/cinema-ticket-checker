import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chromium, firefox } from "playwright";
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
const BOOKING_REQUEST_TIMEOUT_MS = Number(
  process.env.BOOKING_REQUEST_TIMEOUT_MS ?? 15_000,
);
const MAX_SHOWTIMES = Number(process.env.MAX_SHOWTIMES ?? 0);
const DRY_RUN = process.env.DRY_RUN === "1";
const execFileAsync = promisify(execFile);
const USER_AGENT =
  "vox-ticket-watcher/1.0 (+read-only availability monitoring; no automated booking)";

function normalize(value) {
  return value.trim().replace(/\s+/g, " ").toUpperCase();
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
      "user-agent": USER_AGENT,
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

async function openPage(page, url) {
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

  await page.waitForTimeout(700);
}

async function discoverDatePages(page, todayKey) {
  const baseUrl = showtimesUrl();
  await openPage(page, baseUrl.href);
  await waitForMovieCards(page);

  const dateKeys = new Set([todayKey]);
  const hrefs = await page.locator("a[href]").evaluateAll((anchors) =>
    anchors.map((anchor) => anchor.href),
  );

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

async function collectEligibleShowtimes(page, dates) {
  const eligible = [];
  const errors = [];

  for (const date of dates) {
    try {
      await openPage(page, date.url);
      await waitForMovieCards(page);
      const movies = await extractMovieShowtimes(page);

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

function decodeHtml(value) {
  return value
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#x27;|&#39;/gi, "'")
    .replace(/&#x3d;|&#61;/gi, "=");
}

function htmlAttribute(tag, name) {
  const match = tag.match(
    new RegExp(
      `${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`,
      "i",
    ),
  );
  return match ? decodeHtml(match[1] ?? match[2] ?? match[3] ?? "") : "";
}

function hasDisabledAttribute(tag) {
  return /\sdisabled(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?(?=\s|>)/i.test(
    tag,
  );
}

function readSeatLabelsFromHtml(html) {
  const records = [...html.matchAll(/<input\b[^>]*>/gi)]
    .map(([tag]) => {
      if (htmlAttribute(tag, "name").toLowerCase() !== "seat") {
        return null;
      }

      return {
        label: (htmlAttribute(tag, "data-label") || htmlAttribute(tag, "value")).trim(),
        available: !hasDisabledAttribute(tag),
      };
    })
    .filter((record) => record?.label);

  if (records.length === 0) {
    throw new Error("The booking page returned no labelled seats");
  }

  return records;
}

function seatFetchUrlFromHtml(html, baseUrl) {
  const link = html.match(
    /(?:href|action)=["']([^"']*\/seats\/fetch[^"']*)["']/i,
  );
  return link ? new URL(decodeHtml(link[1]), baseUrl).href : null;
}

function bookingBaseUrl(value) {
  const url = new URL(value);
  url.pathname = url.pathname
    .replace(/\/guest(?:\/processing)?\/?$/i, "")
    .replace(/\/+$/, "");
  url.hash = "";
  return url;
}

function guestPageUrlFromBooking(value) {
  const url = bookingBaseUrl(value);
  url.pathname += "/guest";
  return url.href;
}

function seatFetchUrlFromBooking(value) {
  const url = bookingBaseUrl(value);
  url.pathname += "/seats/fetch";
  url.hash = "seats";
  return url.href;
}

async function fileExists(path) {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}

async function curlHtml(url, cookieFile, outputFile, referer) {
  const timeoutSeconds = Math.max(10, Math.ceil(BOOKING_REQUEST_TIMEOUT_MS / 1000));
  const args = [
    "--silent",
    "--show-error",
    "--write-out",
    "__VOX_EFFECTIVE_URL__%{url_effective}",
    "--location",
    "--compressed",
    "--http1.1",
    "--max-time",
    String(timeoutSeconds),
    "--connect-timeout",
    String(timeoutSeconds),
    "--header",
    "accept: text/html,application/xhtml+xml",
    "--cookie-jar",
    cookieFile,
    "--output",
    outputFile,
  ];

  if (referer) {
    args.push("--referer", referer);
  }
  if (await fileExists(cookieFile)) {
    args.push("--cookie", cookieFile);
  }

  args.push(url);
  try {
    const result = await execFileAsync("curl", args, {
      timeout: BOOKING_REQUEST_TIMEOUT_MS + 10_000,
      maxBuffer: 2 * 1024 * 1024,
    });
    const effectiveUrl = result.stdout
      .split("__VOX_EFFECTIVE_URL__")
      .pop()
      ?.trim();
    return {
      html: await readFile(outputFile, "utf8"),
      effectiveUrl: effectiveUrl || url,
    };
  } catch (error) {
    try {
      const partialHtml = await readFile(outputFile, "utf8");
      if (
        /name=["']seat["']/i.test(partialHtml) ||
        partialHtml.includes("/seats/fetch") ||
        partialHtml.includes("/guest")
      ) {
        return { html: partialHtml, effectiveUrl: url };
      }
    } catch {
      // Fall through to the detailed request error below.
    }

    const detail = String(error?.stderr || error?.message || "unknown curl error")
      .replace(/\s+/g, " ")
      .slice(0, 180);
    throw new Error(`VOX booking request failed: ${detail}`);
  }
}

async function readBookingSeatLabels(url) {
  const workingDirectory = await mkdtemp(join(tmpdir(), "vox-ticket-watcher-"));
  const cookieFile = join(workingDirectory, "cookies.txt");
  const initialFile = join(workingDirectory, "initial.html");
  const guestFile = join(workingDirectory, "guest.html");
  const seatsFile = join(workingDirectory, "seats.html");

  try {
    const initialResponse = await curlHtml(
      url,
      cookieFile,
      initialFile,
      showtimesUrl().href,
    );
    const initialBaseUrl = initialResponse.effectiveUrl || url;
    const guestPageUrl = guestPageUrlFromBooking(initialBaseUrl);
    const guestResponse = await curlHtml(
      guestPageUrl,
      cookieFile,
      guestFile,
      initialBaseUrl,
    );
    const guestBaseUrl = guestResponse.effectiveUrl || guestPageUrl;
    const guestUrl =
      seatFetchUrlFromHtml(initialResponse.html, initialBaseUrl) ||
      seatFetchUrlFromHtml(guestResponse.html, guestBaseUrl) ||
      seatFetchUrlFromBooking(guestBaseUrl);
    const seatResponse = await curlHtml(
      guestUrl,
      cookieFile,
      seatsFile,
      guestBaseUrl,
    );
    try {
      return readSeatLabelsFromHtml(seatResponse.html);
    } catch (error) {
      const diagnostics = [
        "initial=" + initialResponse.html.length + " bytes",
        "guest=" + guestResponse.html.length + " bytes",
        "seats=" + seatResponse.html.length + " bytes",
        "guestUrl=" + guestUrl,
        "effective=" + (seatResponse.effectiveUrl || "unknown"),
      ].join(", ");
      throw new Error(errorMessage(error) + " (" + diagnostics + ")");
    }
  } finally {
    await rm(workingDirectory, { recursive: true, force: true });
  }
}

async function maybeContinueAsGuest(page) {
  const seats = page.locator('input[name="seat"]');
  try {
    await seats.first().waitFor({
      state: "attached",
      timeout: Math.min(5_000, REQUEST_TIMEOUT_MS),
    });
    return;
  } catch {
    // VOX may first show /guest/processing before rendering the guest link.
  }

  const guestButton = page.getByText(/Continue\s+as\s+Guest/i).first();
  await guestButton.waitFor({ state: "visible", timeout: REQUEST_TIMEOUT_MS });
  // Trigger the normal link navigation without making Playwright wait for
  // VOX's booking response to finish streaming.
  await guestButton.evaluate((element) => element.click());
  await seats.first().waitFor({
    state: "attached",
    timeout: REQUEST_TIMEOUT_MS,
  });
}

async function maybeAcceptConsent(page) {
  const agreeLink = page
    .locator('a[data-dismiss="true"]')
    .filter({ hasText: /I Agree/i })
    .first();

  if ((await agreeLink.count()) > 0 && (await agreeLink.isVisible())) {
    await agreeLink.click();
    await page.waitForTimeout(300);
  }
}

async function readSeatLabels(page) {
  const seats = page.locator('input[name="seat"]');
  await seats.first().waitFor({ state: "attached", timeout: REQUEST_TIMEOUT_MS });

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

async function readBookingSeatLabelsWithBrowser(browser, url) {
  const context = await browser.newContext({
    locale: "en-US",
    timezoneId: CONFIG.timeZone,
  });
  const page = await context.newPage();

  try {
    await page.goto(url, {
      waitUntil: "commit",
      timeout: REQUEST_TIMEOUT_MS,
    });
    await page.waitForLoadState("domcontentloaded", {
      timeout: REQUEST_TIMEOUT_MS,
    }).catch(() => {});
    await maybeAcceptConsent(page);
    await maybeContinueAsGuest(page);
    await maybeAcceptConsent(page);
    return await readSeatLabels(page);
  } finally {
    await context.close();
  }
}

async function checkSeats(browser, showtime) {
  const seats = await readBookingSeatLabelsWithBrowser(
    browser,
    showtime.bookingUrl,
  );
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
    return error.message.replace(/\s+/g, " ").slice(0, 240);
  }
  return String(error).replace(/\s+/g, " ").slice(0, 240);
}

async function inspectEligibleShowtimes(browser, eligible, initialErrors) {
  const results = [];
  const errors = [...initialErrors];
  const showtimes =
    MAX_SHOWTIMES > 0 ? eligible.slice(0, MAX_SHOWTIMES) : eligible;

  for (const showtime of showtimes) {
    try {
      results.push(await checkSeats(browser, showtime));
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
    "🔵 VOX CHECK COMPLETED",
    `${formatCairoNow()} | ${CONFIG.cinema}`,
    `Dates scanned: ${report.dates.length}`,
    `Eligible showtimes checked: ${report.results.length}/${report.eligible.length}`,
    "",
  ];

  for (const target of CONFIG.targets) {
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
    "🚨 VOX SEATS AVAILABLE",
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
  let bookingBrowser;
  let listingContext;
  let report = {
    dates: [],
    eligible: [],
    results: [],
    errors: [],
  };

  try {
    listingBrowser = await chromium.launch({
      headless: true,
      args: ["--disable-dev-shm-usage"],
    });
    listingContext = await listingBrowser.newContext({
      locale: "en-US",
      timezoneId: CONFIG.timeZone,
      userAgent: USER_AGENT,
    });
    const listingPage = await listingContext.newPage();
    const dates = await discoverDatePages(listingPage, todayKey);
    const { eligible, errors: showtimeErrors } =
      await collectEligibleShowtimes(listingPage, dates);
    await listingContext.close();
    listingContext = null;
    await listingBrowser.close();
    listingBrowser = null;
    bookingBrowser = await firefox.launch({
      headless: true,
    });
    const { results, errors: seatErrors } = await inspectEligibleShowtimes(
      bookingBrowser,
      eligible,
      showtimeErrors,
    );

    report = { dates, eligible, results, errors: seatErrors };
  } catch (error) {
    report.errors.push({ stage: "run", message: errorMessage(error) });
  } finally {
    if (listingContext) {
      await listingContext.close();
    }
    if (listingBrowser) {
      await listingBrowser.close();
    }
    if (bookingBrowser) {
      await bookingBrowser.close();
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
        checkedShowtimes: report.results.length,
        matches: report.results.filter((result) => result.availablePairs.length)
          .length,
        errors: report.errors.length,
        dryRun: DRY_RUN,
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
