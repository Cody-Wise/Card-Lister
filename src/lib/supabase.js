import { createHash } from "node:crypto";
import { createClient } from "@supabase/supabase-js";

let client = null;

export function hasSupabaseConfig() {
  return Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
}

export function getSupabase() {
  if (!client) {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    client = createClient(url, key, {
      auth: { persistSession: false },
    });
  }
  return client;
}

export function camelToSnake(str) {
  return str.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`);
}

export function snakeToCamel(str) {
  return str.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}

export function mapKeys(obj, fn) {
  if (Array.isArray(obj)) return obj.map((item) => mapKeys(item, fn));
  if (obj === null || typeof obj !== "object") return obj;
  const result = {};
  for (const [key, value] of Object.entries(obj)) {
    result[fn(key)] = value;
  }
  return result;
}

function cacheRowId(cacheKey) {
  return `cache_${createHash("sha1").update(String(cacheKey)).digest("hex")}`;
}

function isMissingCacheTableError(error) {
  const message = String(error?.message || "");
  return message.includes("cardhedge_cache") && (
    message.includes("relation") ||
    message.includes("schema cache") ||
    message.includes("Could not find")
  );
}

export async function getCacheEntry(cacheKey) {
  if (!hasSupabaseConfig()) return null;
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("cardhedge_cache")
    .select("*")
    .eq("cache_key", cacheKey)
    .maybeSingle();
  if (error) {
    if (isMissingCacheTableError(error)) return null;
    throw error;
  }
  return data ? mapKeys(data, snakeToCamel) : null;
}

export async function upsertCacheEntry({
  cacheKey,
  cacheType,
  payload,
  metadata = null,
  expiresAt = null,
}) {
  if (!hasSupabaseConfig()) return null;
  const supabase = getSupabase();
  const row = {
    id: cacheRowId(cacheKey),
    cache_key: cacheKey,
    cache_type: cacheType,
    payload,
    metadata,
    expires_at: expiresAt,
    updated_at: new Date().toISOString(),
  };
  const { data, error } = await supabase
    .from("cardhedge_cache")
    .upsert(row, { onConflict: "cache_key" })
    .select()
    .maybeSingle();
  if (error) {
    if (isMissingCacheTableError(error)) return null;
    throw error;
  }
  return data ? mapKeys(data, snakeToCamel) : null;
}
