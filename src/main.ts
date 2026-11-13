import { device } from "@shared/device";
import manifest from "./appmeta/manifest.json";
import { createScreen, type Element } from "./screen";

/** The name the app draws under; the device clears elements by this id. */
const APP = manifest.id;

const GRAPHQL = "https://api.github.com/graphql";
/** Only the level of each day of the last year: about 14 KB. */
const QUERY =
  "query($login:String!){user(login:$login){contributionsCollection{contributionCalendar{weeks{contributionDays{contributionLevel}}}}}}";
const POLL_MS = 30 * 60 * 1000;

const WHITE = "#FFFFFFFF";
const YELLOW = "#FFD000FF";

/** GitHub's levels, NONE to FOURTH_QUARTILE, as XPM colour keys "0" to "4". */
const LEVELS = ["NONE", "FIRST_QUARTILE", "SECOND_QUARTILE", "THIRD_QUARTILE", "FOURTH_QUARTILE"];
/** The greens of GitHub's dark theme; days outside the year stay unlit. */
const PALETTE = ["0 c #161B22", "1 c #0E4429", "2 c #006D32", "3 c #26A641", "4 c #39D353", ". c none"];
/** A day is one pixel wide and two tall: 7 days fill 14 of the 16 rows. */
const DAY_H = 2;

/** The login and the token saved on the app's settings page, or the defaults. */
async function loadSettings(): Promise<{ login: string; token: string }> {
  const { values } = await device.AppsSettingsGet({ app_id: APP });
  return {
    login: typeof values.login === "string" ? values.login.trim() : "vvzvlad",
    token: typeof values.token === "string" ? values.token.trim() : "",
  };
}

/** The year's weeks, oldest first, each a list of levels 0–4 from Sunday on. */
async function load(login: string, token: string): Promise<number[][]> {
  const res = await fetch(GRAPHQL, {
    method: "POST",
    headers: {
      Authorization: `bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query: QUERY, variables: { login } }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return weeksOf(await res.text());
}

/**
 * Reads the levels out of the answer's text in one pass: "contributionDays" opens a week, each "contributionLevel"
 * adds a day to it. JSON.parse builds an object for each of the 371 days: on the emulator a year's answer took the
 * heap's peak to 112 of 128 KiB that way, and to 79 KiB this way.
 */
function weeksOf(text: string): number[][] {
  const weeks: number[][] = [];
  const pattern = /contributionDays|"contributionLevel":"([A-Z_]+)"/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    if (match[1] === undefined) weeks.push([]);
    else if (weeks.length > 0) weeks[weeks.length - 1].push(Math.max(0, LEVELS.indexOf(match[1])));
  }
  if (weeks.length === 0) throw new Error(`no weeks in the answer: ${text.slice(0, 80)}`);
  return weeks;
}

/**
 * The graph as XPM2: a column per week, newest on the right, Sunday on top. The first week of the year lacks its
 * first days and the current one its last, so a short first week sits at the bottom and a short last week at the top.
 */
function xpm(weeks: number[][]): string {
  const rows: string[] = [];
  for (let day = 0; day < 7; day++) {
    let row = "";
    weeks.forEach((week, i) => {
      const at = i === 0 ? day - (7 - week.length) : day;
      row += at >= 0 && at < week.length ? String(week[at]) : ".";
    });
    for (let k = 0; k < DAY_H; k++) rows.push(row);
  }
  return ["! XPM2", `${weeks.length} ${7 * DAY_H} ${PALETTE.length} 1`, ...PALETTE, ...rows].join("\n");
}

/** "SET TOKEN" without a token, "--" without data, else the graph against the right edge. */
function frame(token: string, weeks: number[][] | null): Element[] {
  if (token === "") {
    return [{ type: "text", id: "hint", text: "SET TOKEN", font: "small", color: YELLOW, x: 36, y: 8, align: "center" }];
  }
  if (weeks === null || weeks.length === 0) {
    return [{ type: "text", id: "dash", text: "--", font: "large", color: WHITE, x: 36, y: 8, align: "center" }];
  }
  return [{ type: "xpmbitmap", id: "graph", data: xpm(weeks), x: 72 - weeks.length, y: 1, align: "top_left" }];
}

/**
 * Entry point, called at the end of the file: the device runs this script from top to bottom and starts nothing by itself.
 */
function main(): void {
  let login = "vvzvlad";
  let token = "";
  let weeks: number[][] | null = null;
  let loading = false;
  let stopped = false;

  const report = (err: unknown) =>
    console.error(`${APP}: ${err instanceof Error ? err.message : String(err)}`);
  const screen = createScreen(APP, report);
  const redraw = () => screen.show(frame(token, weeks));

  // One request at a time; a failed one shows "--" until the next poll.
  async function poll(): Promise<void> {
    if (loading) return;
    loading = true;
    try {
      weeks = await load(login, token);
    } catch (err) {
      weeks = null;
      report(err);
    }
    loading = false;
    if (!stopped) redraw();
  }

  // Without a token nothing is asked: the screen says so, and the listener alone keeps the app open.
  let timer: ReturnType<typeof setInterval> | undefined;
  void (async () => {
    try {
      ({ login, token } = await loadSettings());
    } catch (err) {
      report(err);
    }
    if (stopped) return;
    redraw();
    if (token === "") return;
    await poll();
    if (!stopped) timer = setInterval(() => void poll(), POLL_MS);
  })().catch(report);

  // Back leaves the app. Once the timer is cleared and the handler detached, nothing keeps it alive and the device takes the screen back.
  const unbind = listen("input", (event) => {
    if (stopped || event.key !== "back" || event.action !== "short") return;

    stopped = true;
    screen.close();
    if (timer !== undefined) clearInterval(timer);

    // Not detached from inside the handler itself: with nothing else left the unbind stops the app on the spot, while this handler is still running.
    setTimeout(unbind, 0);
  });
}

main();
