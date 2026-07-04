// DA Card World daily watcher — current new releases and sales/deals from
// https://www.dacardworld.com/, refreshed on a schedule (see
// DACARDWORLD_WATCH_INTERVAL_MINUTES in src/server.js), not on every page
// visit. Peer extraction to the other src/routes/*.js files, not a wrapper.
import { sendJson } from "../lib/http.js";
import {
  hasDaCardWorldConfig,
  getDaCardWorldSnapshot,
  refreshDaCardWorldWatch,
} from "../services/dacardworld.js";

// Guards the manual refresh route against exactly the mistake Market Heat
// made (see src/services/apify.js's marketHeatFresh/getApifyBudgetStatus
// history): a repeated-click refresh button that bypasses any freshness
// check and launches a new (here, resource-heavy headless-browser) run on
// every click. A real run here also can't overlap with itself — a second
// Playwright launch mid-run would just contend for the same persistent
// browser profile directory.
let refreshInProgress = false;
const MIN_REFRESH_INTERVAL_MS = Math.max(
  5 * 60 * 1000,
  Number.parseInt(process.env.DACARDWORLD_MIN_REFRESH_MINUTES || "60", 10) * 60 * 1000 || 60 * 60 * 1000,
);

export async function handleDaCardWorldApiRoutes(req, res, { pathname }) {
  if (req.method === "GET" && pathname === "/api/dacardworld") {
    const snapshot = await getDaCardWorldSnapshot();
    sendJson(res, 200, snapshot);
    return true;
  }

  if (req.method === "POST" && pathname === "/api/dacardworld/refresh") {
    if (!hasDaCardWorldConfig()) {
      sendJson(res, 400, { error: "CAPSOLVER_API_KEY is not configured." });
      return true;
    }
    if (refreshInProgress) {
      sendJson(res, 409, { error: "A refresh is already in progress — try again shortly." });
      return true;
    }
    const snapshot = await getDaCardWorldSnapshot();
    const lastRun = Date.parse(snapshot.generatedAt || "");
    if (Number.isFinite(lastRun) && Date.now() - lastRun < MIN_REFRESH_INTERVAL_MS) {
      const minutesLeft = Math.ceil((MIN_REFRESH_INTERVAL_MS - (Date.now() - lastRun)) / 60_000);
      sendJson(res, 429, {
        error: `Already refreshed recently — try again in about ${minutesLeft} minute(s).`,
      });
      return true;
    }

    refreshInProgress = true;
    sendJson(res, 202, { ok: true, message: "Refresh started" });
    (async () => {
      try {
        await refreshDaCardWorldWatch();
      } catch (error) {
        console.error("[dacardworld] manual refresh failed:", error.message);
      } finally {
        refreshInProgress = false;
      }
    })();
    return true;
  }

  return false;
}
