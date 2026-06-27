import { handler } from "../src/app.js";
import { syncLocalToSupabase } from "../src/lib/store.js";

let synced = false;

syncLocalToSupabase().then((r) => {
  synced = true;
  if (r.synced) console.log(`Synced ${r.cardCount} local cards to Supabase`);
});

export default async function vercelHandler(req, res) {
  if (!synced) {
    try {
      const r = await syncLocalToSupabase();
      synced = true;
      if (r.synced) console.log(`Synced ${r.cardCount} local cards to Supabase`);
    } catch {}
  }
  try {
    await handler(req, res);
  } catch (error) {
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: error.message }));
    }
  }
}
