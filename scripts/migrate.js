import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getSupabase, camelToSnake, mapKeys } from "../src/lib/supabase.js";
import { loadEnvFile } from "../src/lib/load-env.js";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stateFile = path.join(rootDir, "data", "state.json");
const imagesDir = path.join(rootDir, "data", "images");

async function main() {
  await loadEnvFile();

  console.log("=== Supabase Migration ===");
  console.log("");

  const raw = await fs.readFile(stateFile, "utf8");
  const state = JSON.parse(raw);
  console.log(`Loaded state.json:`);
  console.log(`  batches:        ${state.batches.length}`);
  console.log(`  cardItems:      ${state.cardItems.length}`);
  console.log(`  cardImages:     ${state.cardImages.length}`);
  console.log(`  cardIdentities: ${state.cardIdentities.length}`);
  console.log(`  comps:          ${state.comps.length}`);
  console.log(`  offers:         ${state.offers.length}`);
  console.log(`  auditEvents:    ${state.auditEvents.length}`);
  console.log(`  counters:       ${Object.keys(state.counters).length}`);
  console.log("");

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error("ERROR: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in .env");
    process.exit(1);
  }

  const supabase = getSupabase();

  console.log("Verifying Supabase connection...");
  const { error: pingErr } = await supabase.from("counters").select("*").limit(1);
  if (pingErr) {
    console.error(`ERROR: Cannot reach Supabase: ${pingErr.message}`);
    process.exit(1);
  }
  console.log("  Connected successfully.");
  console.log("");

  const tables = [
    "comps",
    "offers",
    "audit_events",
    "card_images",
    "card_items",
    "card_identities",
    "batches",
  ];

  console.log("Clearing existing data...");
  for (const table of tables) {
    const { error } = await supabase.from(table).delete().gte("id", "");
    if (error && !error.message?.includes("No rows")) {
      console.error(`  ${table}: delete failed - ${error.message}`);
    } else {
      console.log(`  ${table}: cleared`);
    }
  }

  function toSnakeRows(arr) {
    return arr.map((r) => mapKeys(r, camelToSnake));
  }

  console.log("");
  console.log("Inserting batches...");
  if (state.batches.length) {
    const { error } = await supabase.from("batches").insert(toSnakeRows(state.batches));
    if (error) return console.error(`  FAILED: ${error.message}`);
    console.log(`  Inserted ${state.batches.length} batches.`);
  }

  console.log("Inserting card identities...");
  if (state.cardIdentities.length) {
    const { error } = await supabase
      .from("card_identities")
      .insert(toSnakeRows(state.cardIdentities));
    if (error) return console.error(`  FAILED: ${error.message}`);
    console.log(`  Inserted ${state.cardIdentities.length} card identities.`);
  }

  console.log("Inserting card items...");
  if (state.cardItems.length) {
    const { error } = await supabase.from("card_items").insert(toSnakeRows(state.cardItems));
    if (error) return console.error(`  FAILED: ${error.message}`);
    console.log(`  Inserted ${state.cardItems.length} card items.`);
  }

  console.log("Inserting card images...");
  const storageUrlPrefix = `${process.env.SUPABASE_URL}/storage/v1/object/public/card-images`;
  const updatedImages = state.cardImages.map((img) => ({
    ...img,
    url: img.fileName ? `${storageUrlPrefix}/${img.fileName}` : img.url,
  }));
  if (updatedImages.length) {
    const { error } = await supabase.from("card_images").insert(toSnakeRows(updatedImages));
    if (error) return console.error(`  FAILED: ${error.message}`);
    console.log(`  Inserted ${updatedImages.length} card images.`);
  }

  console.log("Inserting comps...");
  if (state.comps.length) {
    const { error } = await supabase.from("comps").insert(toSnakeRows(state.comps));
    if (error) return console.error(`  FAILED: ${error.message}`);
    console.log(`  Inserted ${state.comps.length} comps.`);
  }

  console.log("Inserting offers...");
  if (state.offers.length) {
    const { error } = await supabase.from("offers").insert(toSnakeRows(state.offers));
    if (error) return console.error(`  FAILED: ${error.message}`);
    console.log(`  Inserted ${state.offers.length} offers.`);
  }

  console.log("Inserting audit events...");
  if (state.auditEvents.length) {
    const { error } = await supabase.from("audit_events").insert(toSnakeRows(state.auditEvents));
    if (error) return console.error(`  FAILED: ${error.message}`);
    console.log(`  Inserted ${state.auditEvents.length} audit events.`);
  }

  console.log("Saving counters...");
  for (const [prefix, value] of Object.entries(state.counters)) {
    const { error } = await supabase
      .from("counters")
      .upsert({ prefix, value }, { onConflict: "prefix" });
    if (error) return console.error(`  FAILED counter ${prefix}: ${error.message}`);
  }
  console.log(`  Saved ${Object.keys(state.counters).length} counters.`);

  console.log("");
  console.log("Uploading images to Supabase Storage...");
  const imageFiles = await fs.readdir(imagesDir).catch(() => []);
  let uploaded = 0;
  let failed = 0;
  for (const fileName of imageFiles) {
    const filePath = path.join(imagesDir, fileName);
    const bytes = await fs.readFile(filePath);
    const ext = path.extname(fileName).toLowerCase();
    const mimeType =
      ext === ".jpg" || ext === ".jpeg"
        ? "image/jpeg"
        : ext === ".png"
          ? "image/png"
          : ext === ".webp"
            ? "image/webp"
            : "application/octet-stream";
    try {
      const { error } = await supabase.storage.from("card-images").upload(fileName, bytes, {
        contentType: mimeType,
        upsert: true,
      });
      if (error) {
        console.error(`  FAILED ${fileName}: ${error.message}`);
        failed++;
      } else {
        uploaded++;
      }
    } catch (err) {
      console.error(`  FAILED ${fileName}: ${err.message}`);
      failed++;
    }
  }
  console.log(`  Uploaded ${uploaded} images${failed ? `, ${failed} failed` : ""}.`);

  console.log("");
  console.log("Migration complete.");
  console.log("");
  console.log("Next steps:");
  console.log("  1. Start the app: npm start");
  console.log("  2. Verify all endpoints work");
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
