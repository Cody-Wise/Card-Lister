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

const server = http.createServer((req, res) => {
  try {
    handler(req, res).catch((error) => {
      try {
        res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: error.message }));
      } catch {
        console.error("Failed to send error response:", error.message);
      }
    });
  } catch (error) {
    try {
      res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: error.message }));
    } catch {
      console.error("Failed to send error response:", error.message);
    }
  }
});

server.listen(port, host, () => {
  console.log(`Automatic Sports Card Listing running on http://${host}:${port}`);
});
