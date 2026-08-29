export const CONFIG = Object.freeze({
  origin: "https://egy.voxcinemas.com",
  showtimesPath:
    "/showtimes?c=city-centre-almaza&m=spider-man-brand-new-day&m=the-odyssey",
  cinema: "City Centre Almaza",
  timeZone: "Africa/Cairo",
  earliestStartMinutes: 19 * 60,
  targets: Object.freeze([
    Object.freeze({
      id: "spider-man-gold",
      movieSlug: "spider-man-brand-new-day",
      movieName: "Spider-Man: Brand New Day",
      format: "GOLD",
      seatGroups: Object.freeze([
        Object.freeze(["C-6", "C-5"]),
        Object.freeze(["C-4", "C-3"]),
      ]),
    }),
    Object.freeze({
      id: "the-odyssey-imax",
      movieSlug: "the-odyssey",
      movieName: "The Odyssey",
      format: "IMAX",
      seatGroups: Object.freeze([
        Object.freeze(["E-16", "E-15"]),
        Object.freeze(["F-16", "F-15"]),
        Object.freeze(["G-16", "G-15"]),
        Object.freeze(["H-16", "H-15"]),
        Object.freeze(["I-16", "I-15"]),
      ]),
    }),
  ]),
});

export function showtimesUrl() {
  return new URL(CONFIG.showtimesPath, CONFIG.origin);
}

export function urlForDate(dateKey, todayKey) {
  const url = showtimesUrl();
  if (dateKey !== todayKey) {
    url.searchParams.set("d", dateKey);
  }
  return url;
}

export function cairoDateKey(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: CONFIG.timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);

  const values = Object.fromEntries(
    parts
      .filter(({ type }) => type !== "literal")
      .map(({ type, value }) => [type, value]),
  );

  return `${values.year}${values.month}${values.day}`;
}

export function formatDateKey(dateKey) {
  const year = Number(dateKey.slice(0, 4));
  const month = Number(dateKey.slice(4, 6));
  const day = Number(dateKey.slice(6, 8));
  const date = new Date(Date.UTC(year, month - 1, day));

  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "UTC",
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(date);
}

export function formatCairoNow(date = new Date()) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: CONFIG.timeZone,
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

export function parseTimeToMinutes(timeText) {
  const match = timeText
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "")
    .match(/^(\d{1,2})(?::(\d{2}))?(am|pm)$/);

  if (!match) {
    return Number.NaN;
  }

  const hour = Number(match[1]);
  const minute = Number(match[2] ?? "0");
  const meridiem = match[3];

  if (hour < 1 || hour > 12 || minute > 59) {
    return Number.NaN;
  }

  let twentyFourHour = hour % 12;
  if (meridiem === "pm") {
    twentyFourHour += 12;
  }

  return twentyFourHour * 60 + minute;
}

