// User-facing push notifications (distinct from src/lib/uptime-kuma.js,
// which is scheduler-health monitoring). Configured via PUSH_NOTIFY_URL:
//
//   - An ntfy topic URL (https://ntfy.sh/<topic> or self-hosted) — the
//     message is POSTed as the plain-text body with ntfy's standard
//     Title/Priority/Tags/Click headers. This is also a sane generic
//     webhook shape for anything that accepts raw text.
//   - A Discord webhook URL (discord.com/api/webhooks/...) — detected by
//     hostname and sent as Discord's required {content} JSON instead.
//
// Best-effort by design: a notification failure must never break the scan
// or scheduler that triggered it, so failures are logged and reported in
// the return value rather than thrown. Callers that need retry-on-next-run
// semantics (e.g. the Best Offers scan's notified-IDs dedup) should only
// mark a notification as delivered when `sent` is true.
const NOTIFY_TIMEOUT_MS = 8000;

export function hasPushNotifyConfig() {
  return Boolean(String(process.env.PUSH_NOTIFY_URL || "").trim());
}

function isDiscordWebhook(url) {
  try {
    const { hostname, pathname } = new URL(url);
    return /(^|\.)discord\.com$/i.test(hostname) && pathname.startsWith("/api/webhooks/");
  } catch {
    return false;
  }
}

export async function sendPushNotification({ title, message, clickUrl = null }) {
  const target = String(process.env.PUSH_NOTIFY_URL || "").trim();
  if (!target) return { sent: false, reason: "not configured" };

  try {
    let response;
    if (isDiscordWebhook(target)) {
      response = await fetch(target, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: `**${title}**\n${message}${clickUrl ? `\n${clickUrl}` : ""}`,
        }),
        signal: AbortSignal.timeout(NOTIFY_TIMEOUT_MS),
      });
    } else {
      response = await fetch(target, {
        method: "POST",
        headers: {
          Title: String(title || "").slice(0, 200),
          Priority: "high",
          Tags: "moneybag",
          ...(clickUrl ? { Click: clickUrl } : {}),
        },
        body: String(message || ""),
        signal: AbortSignal.timeout(NOTIFY_TIMEOUT_MS),
      });
    }
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      console.warn(`[notify] push failed (HTTP ${response.status}): ${body.slice(0, 200)}`);
      return { sent: false, reason: `HTTP ${response.status}` };
    }
    return { sent: true };
  } catch (error) {
    console.warn(`[notify] push failed: ${error.message}`);
    return { sent: false, reason: error.message };
  }
}
