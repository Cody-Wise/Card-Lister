// Read-only window onto the card presale-intelligence database (SPEC-card-intel.md).
//
// That project is deliberately standalone — it knows nothing about this app's
// inventory, and this app must not write to it. Everything here is SELECT-only
// against its Postgres, purely so the release calendar and presale
// announcements are visible in the command center instead of only reachable by
// psql and Signal alerts.
//
// Failure is always soft: cardintel runs in a separate container with its own
// lifecycle, so if it is down or unreachable the tab reports that and the rest
// of the app is unaffected. Nothing here is on a request path that matters.
import pg from "pg";

let pool = null;

export function hasPresaleIntelConfig() {
  return Boolean(String(process.env.CARDINTEL_DSN || "").trim());
}

function getPool() {
  if (!hasPresaleIntelConfig()) return null;
  if (pool) return pool;
  pool = new pg.Pool({
    connectionString: process.env.CARDINTEL_DSN,
    max: 2,
    // Short and explicit: a hung cross-container connection must never become
    // a hung page load here.
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30000,
    statement_timeout: 8000,
    application_name: "cardlister-presale-intel",
  });
  // A pool-level error (server restart, network blip) would otherwise surface
  // as an unhandled 'error' event and take the process down.
  pool.on("error", (error) => {
    console.warn("[presale-intel] idle client error:", error.message);
  });
  return pool;
}

const UPCOMING_SQL = `
  SELECT pk.canonical_name,
         pk.year, pk.manufacturer, pk.brand, pk.sport,
         r.release_date,
         r.source,
         r.confidence
    FROM releases r
    JOIN product_keys pk ON pk.id = r.product_key_id
   WHERE r.release_date >= current_date
     AND r.release_date <= current_date + $1::int
   ORDER BY r.release_date, pk.canonical_name`;

// Sources are stored separately on purpose; where they disagree, that spread is
// itself the signal (a street date nobody agrees on is a date that is moving).
const DISAGREEMENT_SQL = `
  SELECT pk.canonical_name,
         min(r.release_date) AS earliest,
         max(r.release_date) AS latest,
         max(r.release_date) - min(r.release_date) AS gap_days,
         count(*) AS source_count
    FROM releases r
    JOIN product_keys pk ON pk.id = r.product_key_id
   WHERE r.release_date >= current_date
   GROUP BY pk.canonical_name, r.product_key_id
  HAVING count(*) > 1 AND max(r.release_date) - min(r.release_date) >= $1::int
   ORDER BY gap_days DESC`;

const ANNOUNCEMENTS_SQL = `
  SELECT ra.id,
         pk.canonical_name,
         ra.presale_open_at,
         ra.street_date,
         ra.price_cents,
         ra.url,
         ra.confidence,
         ra.created_at,
         ei.subject,
         ei.from_addr
    FROM release_announcements ra
    LEFT JOIN product_keys pk ON pk.id = ra.product_key_id
    LEFT JOIN email_ingest  ei ON ei.id = ra.email_id
   ORDER BY ra.created_at DESC
   LIMIT $1::int`;

const STATS_SQL = `
  SELECT
    (SELECT count(*) FROM releases WHERE release_date >= current_date)      AS upcoming_total,
    (SELECT count(*) FROM releases)                                          AS releases_total,
    (SELECT count(*) FROM release_announcements)                             AS announcements_total,
    (SELECT count(*) FROM email_ingest)                                      AS emails_ingested,
    (SELECT count(*) FROM email_ingest WHERE processed_at IS NOT NULL)       AS emails_processed,
    (SELECT max(updated_at) FROM releases)                                   AS calendar_updated_at,
    (SELECT max(received_at) FROM email_ingest)                              AS newest_email_at`;

const SOURCES_SQL = `
  SELECT source, count(*) AS rows,
         min(release_date) AS earliest, max(release_date) AS latest,
         max(updated_at) AS updated_at
    FROM releases
   GROUP BY source
   ORDER BY count(*) DESC`;

export async function getPresaleIntel({ days = 60, gapDays = 7, announcementLimit = 25 } = {}) {
  if (!hasPresaleIntelConfig()) {
    return {
      configured: false,
      error: "CARDINTEL_DSN is not set — the presale intelligence database is not wired up.",
    };
  }
  const client = getPool();
  const horizon = Math.max(1, Math.min(365, Number.parseInt(days, 10) || 60));
  const gap = Math.max(1, Math.min(90, Number.parseInt(gapDays, 10) || 7));
  const limit = Math.max(1, Math.min(200, Number.parseInt(announcementLimit, 10) || 25));

  try {
    const [upcoming, disagreements, announcements, stats, sources] = await Promise.all([
      client.query(UPCOMING_SQL, [horizon]),
      client.query(DISAGREEMENT_SQL, [gap]),
      client.query(ANNOUNCEMENTS_SQL, [limit]),
      client.query(STATS_SQL),
      client.query(SOURCES_SQL),
    ]);
    return {
      configured: true,
      horizonDays: horizon,
      upcoming: upcoming.rows,
      disagreements: disagreements.rows,
      announcements: announcements.rows,
      sources: sources.rows,
      stats: stats.rows[0] || {},
    };
  } catch (error) {
    return {
      configured: true,
      error: `Presale intelligence database unavailable: ${error.message}`,
    };
  }
}
