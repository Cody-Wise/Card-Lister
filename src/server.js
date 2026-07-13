import http from "node:http";
import { loadEnvFile } from "./lib/load-env.js";

function parseArg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0 && index + 1 < process.argv.length) {
    const value = String(process.argv[index + 1] || "").trim();
    if (value) return value;
  }
  return fallback;
}

function parseNumeric(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

await loadEnvFile();
const [{ handler }, { syncLocalToSupabase }] = await Promise.all([
  import("./app.js"),
  import("./lib/store.js"),
]);

syncLocalToSupabase().then((r) => {
  if (r.synced) console.log(`Synced ${r.cardCount} local cards to Supabase`);
});

process.on("uncaughtException", (err) => {
  console.error("UNCAUGHT EXCEPTION:", err.message);
});

process.on("unhandledRejection", (err) => {
  console.error("UNHANDLED REJECTION:", err?.message || err);
});

const port = parseNumeric(parseArg("port", process.env.PORT || "3000"), 3000);
const host = parseArg("host", process.env.HOST || "localhost");

function sendServerError(res, error) {
  try {
    if (res.headersSent) {
      res.end();
      return;
    }
    const statusCode = Number.isInteger(error.statusCode) ? error.statusCode : 500;
    res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: error.message }));
  } catch {
    console.error("Failed to send error response:", error.message);
  }
}

const server = http.createServer((req, res) => {
  try {
    handler(req, res).catch((error) => sendServerError(res, error));
  } catch (error) {
    sendServerError(res, error);
  }
});

server.listen(port, host, () => {
  console.log(`Automatic Sports Card Listing running on http://${host}:${port}`);
});

// Optional background schedulers. Each is off by default; enable by setting
// its interval env var to a positive number of minutes. Each can also
// optionally push its outcome to an Uptime Kuma "Push" monitor (see
// src/lib/uptime-kuma.js) so a scheduler that stops firing or starts always
// failing surfaces as an alert instead of only living in `docker logs`.
const { pingUptimeKuma } = await import("./lib/uptime-kuma.js");

const salesSyncMinutes = Number(process.env.SALES_SYNC_INTERVAL_MINUTES || 0);
if (Number.isFinite(salesSyncMinutes) && salesSyncMinutes > 0) {
  const { syncEbaySales } = await import("./jobs/sales-sync.js");
  const pushUrl = process.env.UPTIME_KUMA_PUSH_URL_SALES_SYNC || "";
  const runSalesSync = () => {
    syncEbaySales()
      .then((result) => {
        const msg = `${result.totalOrders} orders, ${result.matchedLines} lines matched, ${result.updatedCards} cards / ${result.updatedOffers} offers marked sold`;
        console.log(`[sales-sync] ${msg}`);
        pingUptimeKuma(pushUrl, { status: "up", msg });
      })
      .catch((error) => {
        console.error(`[sales-sync] failed: ${error.message}`);
        pingUptimeKuma(pushUrl, { status: "down", msg: error.message });
      });
  };
  const salesSyncTimer = setInterval(runSalesSync, salesSyncMinutes * 60_000);
  salesSyncTimer.unref();
  console.log(`eBay sales sync scheduler enabled every ${salesSyncMinutes} min`);
}

const repriceMinutes = Number(process.env.REPRICE_INTERVAL_MINUTES || 0);
if (Number.isFinite(repriceMinutes) && repriceMinutes > 0) {
  const { repriceUnsoldListings } = await import("./jobs/reprice-scheduler.js");
  const pushUrl = process.env.UPTIME_KUMA_PUSH_URL_REPRICE || "";
  const runReprice = () => {
    repriceUnsoldListings()
      .then((result) => {
        const msg = `evaluated ${result.evaluated}, repriced ${result.repriced}, failed ${result.failed}`;
        console.log(`[reprice] ${msg}`);
        if (result.failed > 0) {
          for (const r of result.results || []) {
            if (r.error) console.warn(`[reprice] failed cardId=${r.cardId} offerId=${r.offerId || "-"}: ${r.error}`);
          }
        }
        pingUptimeKuma(pushUrl, { status: result.failed > 0 ? "down" : "up", msg });
      })
      .catch((error) => {
        console.error(`[reprice] failed: ${error.message}`);
        pingUptimeKuma(pushUrl, { status: "down", msg: error.message });
      });
  };
  const repriceTimer = setInterval(runReprice, repriceMinutes * 60_000);
  repriceTimer.unref();
  console.log(`Repricing scheduler enabled every ${repriceMinutes} min`);
}

const healthCheckMinutes = Number(process.env.DATA_HEALTH_CHECK_INTERVAL_MINUTES || 0);
if (Number.isFinite(healthCheckMinutes) && healthCheckMinutes > 0) {
  const { runDataHealthCheck } = await import("./jobs/data-health-check.js");
  const healthCheckPushUrl = process.env.UPTIME_KUMA_PUSH_URL_DATA_HEALTH_CHECK || "";
  const runHealthCheck = () => {
    runDataHealthCheck()
      .then((result) => {
        const msg = `checked ${result.checkedCards} cards / ${result.checkedOffers} offers, ${result.issuesFound} issue(s) found`;
        console.log(`[data-health-check] ${msg}`);
        for (const issue of result.issues) {
          console.warn(`[data-health-check] ${issue.type}: ${issue.message}`);
        }
        // "down" here means "found data-quality issues worth a look", not
        // that the check itself failed to run — matches how the other
        // schedulers report a bad outcome as down even on a clean execution.
        pingUptimeKuma(healthCheckPushUrl, { status: result.issuesFound > 0 ? "down" : "up", msg });
      })
      .catch((error) => {
        console.error(`[data-health-check] failed: ${error.message}`);
        pingUptimeKuma(healthCheckPushUrl, { status: "down", msg: error.message });
      });
  };
  const healthCheckTimer = setInterval(runHealthCheck, healthCheckMinutes * 60_000);
  healthCheckTimer.unref();
  console.log(`Data health check scheduler enabled every ${healthCheckMinutes} min`);
}

const daCardWorldMinutes = Number(process.env.DACARDWORLD_WATCH_INTERVAL_MINUTES || 0);
if (Number.isFinite(daCardWorldMinutes) && daCardWorldMinutes > 0) {
  const { refreshDaCardWorldWatch } = await import("./services/dacardworld.js");
  const daCardWorldPushUrl = process.env.UPTIME_KUMA_PUSH_URL_DACARDWORLD || "";
  const runDaCardWorldWatch = () => {
    refreshDaCardWorldWatch()
      .then((result) => {
        const msg = `${result.newReleases.length} new release(s), ${result.deals.length} deal(s)`;
        console.log(`[dacardworld] ${msg}`);
        pingUptimeKuma(daCardWorldPushUrl, { status: "up", msg });
      })
      .catch((error) => {
        console.error(`[dacardworld] failed: ${error.message}`);
        pingUptimeKuma(daCardWorldPushUrl, { status: "down", msg: error.message });
      });
  };
  const daCardWorldTimer = setInterval(runDaCardWorldWatch, daCardWorldMinutes * 60_000);
  daCardWorldTimer.unref();
  console.log(`DA Card World watcher enabled every ${daCardWorldMinutes} min`);
}

const bestOffersMinutes = Number(process.env.BEST_OFFERS_SCAN_INTERVAL_MINUTES || 0);
if (Number.isFinite(bestOffersMinutes) && bestOffersMinutes > 0) {
  // Same module instance the HTTP handler uses, so the scan's internal
  // in-progress guard covers scheduler and manual-refresh triggers alike —
  // an overlap would double-send push notifications for the same offer.
  const { refreshBestOffers } = await import("./app.js");
  const bestOffersPushUrl = process.env.UPTIME_KUMA_PUSH_URL_BEST_OFFERS || "";
  const runBestOffersScan = () => {
    refreshBestOffers()
      .then((entries) => {
        const pending = entries.filter((entry) => !entry.error).length;
        const errored = entries.length - pending;
        const msg = `${pending} pending offer(s)${errored ? `, ${errored} lookup error(s)` : ""}`;
        console.log(`[best-offers] ${msg}`);
        pingUptimeKuma(bestOffersPushUrl, { status: "up", msg });
      })
      .catch((error) => {
        console.error(`[best-offers] scan failed: ${error.message}`);
        pingUptimeKuma(bestOffersPushUrl, { status: "down", msg: error.message });
      });
  };
  const bestOffersTimer = setInterval(runBestOffersScan, bestOffersMinutes * 60_000);
  bestOffersTimer.unref();
  console.log(`Best Offers scan scheduler enabled every ${bestOffersMinutes} min`);
}
