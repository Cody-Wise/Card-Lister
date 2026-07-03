// Optional integration with the Uptime Kuma "Push" monitor type
// (https://github.com/louislam/uptime-kuma) already running on this app's
// droplet. Each scheduler (sales-sync, reprice, data-health-check) can ping
// its own push URL after every run so a scheduler that silently stops
// firing — or starts failing every time — shows up as a Kuma alert instead
// of only being visible in `docker logs`. Off by default: if a push URL
// isn't configured for a given job, ping() is a no-op.
function buildPushUrl(baseUrl, { status, msg, ping }) {
  const url = new URL(baseUrl);
  url.searchParams.set("status", status);
  if (msg) url.searchParams.set("msg", msg.slice(0, 300));
  if (Number.isFinite(ping)) url.searchParams.set("ping", String(Math.round(ping)));
  return url.toString();
}

// Fire-and-forget by design — a monitoring ping must never throw or block
// the caller's real work. Failures are logged, not propagated.
export function pingUptimeKuma(pushUrl, { status, msg, ping } = {}) {
  if (!pushUrl) return;
  const url = buildPushUrl(pushUrl, { status, msg, ping });
  fetch(url, { method: "GET" }).catch((error) => {
    console.error(`[uptime-kuma] push failed: ${error.message}`);
  });
}
