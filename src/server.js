import http from "node:http";
import { loadEnvFile } from "./lib/load-env.js";

await loadEnvFile();
const { handler } = await import("./app.js");

const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || "127.0.0.1";

const server = http.createServer((req, res) => {
  handler(req, res).catch((error) => {
    res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: error.message, stack: process.env.NODE_ENV === "production" ? undefined : error.stack }, null, 2));
  });
});

server.listen(port, host, () => {
  console.log(`Automatic Sports Card Listing running on http://${host}:${port}`);
});
