import { device } from "@shared/device";
import { formatDay, formatMonth } from "@shared/datetime";
import manifest from "./appmeta/manifest.json";
import { createScreen, type Element } from "./screen";

/** The name the app draws under; the device clears elements by this id. */
const APP = manifest.id;

const GRAPHQL = "https://api.github.com/graphql";
/**
 * The total, and the count and the level of each day from `from` to `to` with the date of each week's first day;
 * GitHub answers for a year at most. Short aliases for the fields keep a year's answer at about 10 KB.
 */
const QUERY =
  "query($login:String!,$from:DateTime!,$to:DateTime!){user(login:$login){c:contributionsCollection(from:$from,to:$to){c:contributionCalendar{t:totalContributions w:weeks{f:firstDay d:contributionDays{n:contributionCount l:contributionLevel}}}}}}";
const POLL_MS = 30 * 60 * 1000;

/** The weeks of the graph, a column each, the current one on the right: the display's whole width. */
const WEEKS = 72;
const DAY_MS = 24 * 60 * 60 * 1000;

/** localStorage key of the last good data, a Graph as JSON. */
const KEPT_KEY = "graph";

const WHITE = "#FFFFFFFF";
const GRAY = "#A0A0A0FF";
const YELLOW = "#FFD000FF";
/** Data the last request did not bring, kept from an earlier one, is drawn at this brightness. */
const DIM = 0.4;

/** GitHub's levels, NONE to FOURTH_QUARTILE, as XPM colour keys "0" to "4". */
const LEVELS = ["NONE", "FIRST_QUARTILE", "SECOND_QUARTILE", "THIRD_QUARTILE", "FOURTH_QUARTILE"];
/**
 * The colours of levels 0 to 4 in each scheme of the settings: GitHub's dark-theme greens, its Halloween oranges and
 * winter blues, and purples of its Primer palette.
 */
const SCHEMES: Record<string, string[]> = {
  green: ["#161B22", "#0E4429", "#006D32", "#26A641", "#39D353"],
  halloween: ["#161B22", "#631C03", "#BD561D", "#FA7A18", "#FDDF68"],
  blue: ["#161B22", "#0A3069", "#0969DA", "#54AEFF", "#B6E3FF"],
  purple: ["#161B22", "#3C1E70", "#6E40C9", "#A371F7", "#D2A8FF"],
};
/** A day is one pixel wide and two tall: 7 days fill 14 of the 16 rows. */
const DAY_H = 2;
/** Today without a contribution is lit for this long, then unlit for as long: it blinks once a second. */
const BLINK_MS = 500;

/** The no-connection picture, the same in every app. */
const OFFLINE = ["! XPM2", "5 5 2 1", ". c none", "r c #FF3030", "r...r", ".r.r.", "..r..", ".r.r.", "r...r"].join("\n");
/** A picture with nothing in it: today's pixel while it is unlit. */
const NOTHING = ["! XPM2", "1 1 1 1", ". c none", "."].join("\n");

/** The back display: the left edge of the captions beside the numbers, and the top of each of the three rows. */
const CAPTION_X = 56;
const BACK_ROWS = [4, 30, 56];

/**
 * What the displays show, made from the two answers; kept in localStorage as is, for a start without a connection.
 */
interface Graph {
  /** Whose graph it is: what was kept for another login is not shown. */
  login: string;
  /** Each day's level 0–4 as a digit, from the Sunday WEEKS - 1 weeks before this week's to today. */
  levels: string;
  /** Today's contributions: without any today blinks. */
  today: number;
  /** Contributions in the last year: GitHub's own total, the profile's. */
  total: number;
  /** Days in a row with contributions up to today, or up to yesterday while today has none yet. */
  streak: number;
  /** The last year's best day, "YYYY-MM-DD", and its contributions; "" and 0 in a year without any. */
  bestDate: string;
  best: number;
}

/**
 * Where the data stands: no answer yet in this run (what is shown was kept from an earlier one), brought by the last
 * request, or the last request failed.
 */
type Freshness = "waiting" | "live" | "lost";

/** The login, the token and the colours of the scheme saved on the app's settings page, or the defaults. */
async function loadSettings(): Promise<{ login: string; token: string; colors: string[] }> {
  const { values } = await device.AppsSettingsGet({ app_id: APP });
  return {
    login: typeof values.login === "string" ? values.login.trim() : "vvzvlad",
    token: typeof values.token === "string" ? values.token.trim() : "",
    colors: SCHEMES[typeof values.scheme === "string" ? values.scheme : ""] ?? SCHEMES.green,
  };
}

/** Each day's count and level, by its place from the graph's first day. */
interface Days {
  counts: number[];
  levels: number[];
}

/**
 * The WEEKS weeks up to today in two requests: the weeks before the last year, then the last year as GitHub's own
 * graph has it, from this time a year ago, so that its levels and its total are those of the profile. The days are
 * counted from the Sunday that starts the graph, in UTC like GitHub's days.
 */
async function load(login: string, token: string): Promise<Graph> {
  const now = new Date();
  const start =
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - (now.getUTCDay() + 7 * (WEEKS - 1)) * DAY_MS;
  const yearAgo = Date.UTC(
    now.getUTCFullYear() - 1,
    now.getUTCMonth(),
    now.getUTCDate(),
    now.getUTCHours(),
    now.getUTCMinutes(),
    now.getUTCSeconds(),
  );
  const days: Days = { counts: [], levels: [] };
  await loadDays(login, token, start, yearAgo - 1000, start, days);
  const year = await loadDays(login, token, yearAgo, now.getTime(), start, days);
  return { ...summary(days, start, year.first, year.total), login };
}

/**
 * One request for the days from `from` to `to`; each day's count and level go to its place counted from `start`. The
 * place of its first day and the total it gives. The days are read out of the answer's text in one pass: JSON.parse
 * builds an object for each of them, and on the emulator a year's answer took the heap's peak to 112 of 128 KiB that
 * way, and to 79 KiB this way.
 */
async function loadDays(
  login: string,
  token: string,
  from: number,
  to: number,
  start: number,
  days: Days,
): Promise<{ first: number; total: number }> {
  const res = await fetch(GRAPHQL, {
    method: "POST",
    headers: {
      Authorization: `bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      query: QUERY,
      variables: { login, from: new Date(from).toISOString(), to: new Date(to).toISOString() },
    }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  // "t" is the total, "f" a week's first day, and each "n" with its "l" the count and the level of the next day.
  const pattern = /"t":(\d+)|"f":"(\d+)-(\d+)-(\d+)"|"n":(\d+),"l":"([A-Z_]+)"/g;
  let total = 0;
  let first = -1;
  let day = -1;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    if (match[1] !== undefined) {
      total = Number(match[1]);
    } else if (match[2] !== undefined) {
      day = Math.round((Date.UTC(Number(match[2]), Number(match[3]) - 1, Number(match[4])) - start) / DAY_MS);
      if (first < 0) first = day;
    } else {
      days.counts[day] = Number(match[5]);
      days.levels[day] = Math.max(0, LEVELS.indexOf(match[6]));
      day++;
    }
  }
  if (first < 0) throw new Error(`no days in the answer: ${text.slice(0, 80)}`);
  return { first, total };
}

/**
 * The levels of all the days and what the back display shows; the last day is today, a day not answered counts as
 * none. GitHub sets the levels of an answer by its own days, so the days before the last year, from the other
 * answer, are given levels on the last year's scale: each level from the lowest count it has in the last year.
 */
function summary(days: Days, start: number, first: number, total: number): Omit<Graph, "login"> {
  const { counts, levels } = days;
  const last = counts.length - 1;
  const count = (day: number) => counts[day] ?? 0;
  const lowest = [0, Infinity, Infinity, Infinity, Infinity];
  let best = 0;
  let bestDay = -1;
  for (let day = first; day <= last; day++) {
    for (let level = 1; level <= (levels[day] ?? 0); level++) lowest[level] = Math.min(lowest[level], count(day));
    if (count(day) > 0 && count(day) >= best) {
      best = count(day);
      bestDay = day;
    }
  }
  let streak = 0;
  for (let day = count(last) > 0 ? last : last - 1; day >= 0 && count(day) > 0; day--) streak++;
  let digits = "";
  for (let day = 0; day <= last; day++) {
    let level = levels[day] ?? 0;
    if (day < first) {
      level = count(day) > 0 ? 1 : 0;
      while (level > 0 && level < 4 && count(day) >= lowest[level + 1]) level++;
    }
    digits += String(level);
  }
  return {
    levels: digits,
    today: count(last),
    total,
    streak,
    bestDate: bestDay < 0 ? "" : new Date(start + bestDay * DAY_MS).toISOString().slice(0, 10),
    best,
  };
}

/** A colour, "#RRGGBB" or "#RRGGBBAA", at k of its brightness. */
function shade(color: string, k: number): string {
  let out = "#";
  for (let i = 1; i < 7; i += 2) out += Math.round(parseInt(color.slice(i, i + 2), 16) * k).toString(16).padStart(2, "0");
  return out + color.slice(7);
}

/** A colour as drawn: dimmed unless the last request brought the data. */
function fresh(color: string, freshness: Freshness): string {
  return freshness === "live" ? color : shade(color, DIM);
}

/** A whole number with thousands separators: 3463 → "3,463". */
function thousands(value: number): string {
  const digits = String(value);
  let out = "";
  for (let i = 0; i < digits.length; i++) {
    if (i > 0 && (digits.length - i) % 3 === 0) out += ",";
    out += digits[i];
  }
  return out;
}

/** "2026-05-04" → "May 4, 2026". */
function dayText(date: string): string {
  const [year, month, day] = date.split("-").map(Number);
  const d = new Date(year, month - 1, day);
  return `${formatMonth(d)} ${formatDay(d)}, ${year}`;
}

/** The no-connection picture with its top left corner at x, y, above the graph. */
function offline(x: number, y: number): Element {
  return { type: "xpmbitmap", id: "offline", data: OFFLINE, x, y, align: "top_left", z_index: 2 };
}

/**
 * The graph as XPM2 in the scheme's colours: a column per week, newest on the right, Sunday on top. The levels start
 * on a Sunday and end today, so the current week's column is short at the bottom.
 */
function xpm(levels: string, colors: string[]): string {
  const columns = Math.ceil(levels.length / 7);
  const rows: string[] = [];
  for (let day = 0; day < 7; day++) {
    let row = "";
    for (let week = 0; week < columns; week++) {
      const at = week * 7 + day;
      row += at < levels.length ? levels[at] : ".";
    }
    for (let k = 0; k < DAY_H; k++) rows.push(row);
  }
  const palette = colors.map((color, level) => `${level} c ${color}`);
  return ["! XPM2", `${columns} ${7 * DAY_H} ${palette.length + 1} 1`, ...palette, ". c none", ...rows].join("\n");
}

/**
 * "--" without data, else the graph against the right edge, made beforehand as `picture`; today without a contribution
 * gets a white pixel of its own over the graph while `lit`. After a failed request the no-connection picture covers
 * the oldest weeks.
 */
function graphFrame(graph: Graph | null, picture: string, lit: boolean, freshness: Freshness): Element[] {
  const elements: Element[] = [];
  if (graph === null) {
    elements.push({ type: "text", id: "dash", text: "--", font: "large", color: WHITE, x: 36, y: 8, align: "center" });
  } else {
    const last = graph.levels.length - 1;
    elements.push({ type: "xpmbitmap", id: "graph", data: picture, x: 72 - Math.ceil(graph.levels.length / 7), y: 1, align: "top_left" });
    if (graph.today === 0) {
      const data = lit ? ["! XPM2", `1 ${DAY_H} 1 1`, `x c ${fresh(WHITE, freshness).slice(0, 7)}`, ...Array(DAY_H).fill("x")].join("\n") : NOTHING;
      elements.push({ type: "xpmbitmap", id: "today", data, x: 71, y: 1 + (last % 7) * DAY_H, align: "top_left", z_index: 1 });
    }
  }
  if (freshness === "lost") elements.push(offline(0, 0));
  return elements;
}

/**
 * The current streak in large digits on the right, in the scheme's brightest colour, "STREAK" and "DAYS" small on the
 * left; "--" without data. After a failed request the no-connection picture comes before "DAYS".
 */
function streakFrame(graph: Graph | null, colors: string[], freshness: Freshness): Element[] {
  const lost = freshness === "lost";
  const gray = fresh(GRAY, freshness);
  const elements: Element[] = [
    {
      type: "text",
      id: "streak",
      text: graph === null ? "--" : String(graph.streak),
      font: "extra_large",
      color: graph === null ? WHITE : fresh(`${colors[4]}FF`, freshness),
      x: 72,
      y: 8,
      align: "mid_right",
    },
    { type: "text", id: "slabel", text: "STREAK", font: "small", color: gray, x: 0, y: 4, align: "mid_left" },
    { type: "text", id: "sdays", text: graph?.streak === 1 ? "DAY" : "DAYS", font: "small", color: gray, x: lost ? 6 : 0, y: 12, align: "mid_left" },
  ];
  if (lost) elements.push(offline(0, 10));
  return elements;
}

/**
 * The back display: the last year's total, the current streak and the best day, each a number large on the left with
 * two lines small beside it; dimmed as on the front, "--" without data.
 */
function backFrame(graph: Graph | null, freshness: Freshness): Element[] {
  const white = fresh(WHITE, freshness);
  const gray = fresh(GRAY, freshness);
  const rows: [string, string, string][] = [
    [graph === null ? "--" : thousands(graph.total), "contributions", "in the last year"],
    [graph === null ? "--" : String(graph.streak), graph?.streak === 1 ? "day in a row," : "days in a row,", "current streak"],
    [graph === null ? "--" : String(graph.best), "on the best day,", graph === null || graph.bestDate === "" ? "--" : dayText(graph.bestDate)],
  ];
  const elements: Element[] = [];
  rows.forEach(([number, top, bottom], i) => {
    const y = BACK_ROWS[i];
    elements.push(
      { type: "text", id: `bnum${i}`, text: number, font: "large", color: white, x: 0, y, align: "top_left", display: "back" },
      { type: "text", id: `btop${i}`, text: top, font: "small", color: gray, x: CAPTION_X, y: y - 3, align: "top_left", display: "back" },
      { type: "text", id: `bbottom${i}`, text: bottom, font: "small", color: gray, x: CAPTION_X, y: y + 7, align: "top_left", display: "back" },
    );
  });
  return elements;
}

/** The last good data kept in localStorage and the JSON it was read from; null without any. */
function kept(): { graph: Graph | null; json: string | null } {
  try {
    const json = localStorage.getItem(KEPT_KEY);
    return { graph: json ? (JSON.parse(json) as Graph) : null, json };
  } catch {
    return { graph: null, json: null };
  }
}

/**
 * Entry point, called at the end of the file: the device runs this script from top to bottom and starts nothing by itself.
 */
function main(): void {
  let login = "vvzvlad";
  let token = "";
  let colors = SCHEMES.green;
  /** The last good data: from localStorage at the start, then from each good answer. */
  let graph: Graph | null = null;
  let freshness: Freshness = "waiting";
  /** The graph as XPM2, made again when the data or its freshness changes, not on every blink. */
  let picture = "";
  /** What localStorage holds under KEPT_KEY, so that only a change is written. */
  let saved: string | null = null;
  /** The front shows the streak instead of the graph. */
  let streaking = false;
  /** Today's pixel is lit, in the blink's first half. */
  let lit = false;
  let loading = false;
  let stopped = false;
  let blinkTimer: ReturnType<typeof setInterval> | undefined;

  const report = (err: unknown) =>
    console.error(`${APP}: ${err instanceof Error ? err.message : String(err)}`);
  const screen = createScreen(APP, report);
  // "SET TOKEN" without a token; else the graph or the streak, and the back display.
  const redraw = () => {
    if (stopped) return;
    if (token === "") {
      screen.show([{ type: "text", id: "hint", text: "SET TOKEN", font: "small", color: YELLOW, x: 36, y: 8, align: "center" }]);
      return;
    }
    const front = streaking ? streakFrame(graph, colors, freshness) : graphFrame(graph, picture, lit, freshness);
    screen.show(front.concat(backFrame(graph, freshness)));
  };
  const repaint = () => {
    picture = graph === null ? "" : xpm(graph.levels, colors.map((color) => fresh(color, freshness)));
  };

  /** Today blinks while the graph is shown and today has no contribution; only a pending timer is cleared. */
  function blink(): void {
    const blinking = !streaking && graph !== null && graph.today === 0;
    if (blinking && blinkTimer === undefined) {
      blinkTimer = setInterval(() => {
        lit = !lit;
        redraw();
      }, BLINK_MS);
    } else if (!blinking && blinkTimer !== undefined) {
      clearInterval(blinkTimer);
      blinkTimer = undefined;
    }
  }

  /** Writes the data to localStorage when it differs from what it holds: every write rewrites the store in flash. */
  function keep(): void {
    const json = JSON.stringify(graph);
    if (json === saved) return;
    try {
      localStorage.setItem(KEPT_KEY, json);
      saved = json;
    } catch (err) {
      report(err);
    }
  }

  // One poll at a time. A good answer replaces the data and is kept in localStorage; a failed one leaves the last good
  // data on the displays, dimmed, with the no-connection picture.
  async function poll(): Promise<void> {
    if (loading) return;
    loading = true;
    try {
      graph = await load(login, token);
      freshness = "live";
      keep();
    } catch (err) {
      freshness = "lost";
      report(err);
    }
    loading = false;
    // After Back a blink started here would keep the app alive.
    if (stopped) return;
    repaint();
    blink();
    redraw();
  }

  // Without a token nothing is asked: the screen says so, and the listener alone keeps the app open. With one the data
  // kept from an earlier run is shown dimmed until the first answer.
  let timer: ReturnType<typeof setInterval> | undefined;
  void (async () => {
    try {
      ({ login, token, colors } = await loadSettings());
    } catch (err) {
      report(err);
    }
    if (stopped) return;
    if (token !== "") {
      const stored = kept();
      saved = stored.json;
      if (stored.graph?.login === login) graph = stored.graph;
      repaint();
      blink();
    }
    redraw();
    if (token === "") return;
    await poll();
    if (!stopped) timer = setInterval(() => void poll(), POLL_MS);
  })().catch(report);

  // The wheel switches between the graph and the streak, Back leaves the app. Once the timers are cleared and the
  // handler detached, nothing keeps it alive and the device takes the screen back.
  const unbind = listen("input", (event) => {
    if (stopped) return;
    if (event.key === "encoder") {
      if (token === "") return;
      streaking = !streaking;
      blink();
      redraw();
      return;
    }
    if (event.key !== "back" || event.action !== "short") return;

    stopped = true;
    screen.close();
    if (timer !== undefined) clearInterval(timer);
    if (blinkTimer !== undefined) clearInterval(blinkTimer);

    // Not detached from inside the handler itself: with nothing else left the unbind stops the app on the spot, while this handler is still running.
    setTimeout(unbind, 0);
  });
}

main();
