import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createId, nowIso } from "./store.js";
import { getSupabase } from "./supabase.js";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const dataDir = path.join(rootDir, "data");
const imagesDir = path.join(dataDir, "images");

async function ensureDiskDir() {
  await fs.mkdir(imagesDir, { recursive: true });
}

function parseDataUrl(dataUrl) {
  const match = /^data:(.+?);base64,(.+)$/i.exec(dataUrl);
  if (!match) {
    throw new Error("Expected a data URL image");
  }
  return {
    mimeType: match[1],
    bytes: Buffer.from(match[2], "base64"),
  };
}

function extensionFromMime(mimeType, fallback = "png") {
  if (mimeType.includes("jpeg")) return "jpg";
  if (mimeType.includes("png")) return "png";
  if (mimeType.includes("webp")) return "webp";
  return fallback;
}

async function uploadToSupabase(fileName, bytes, mimeType) {
  const supabase = getSupabase();
  // Image filenames are `${imageId}-${side}.${ext}` with a monotonic imageId,
  // so a given filename's bytes never change after upload — safe to mark
  // immutable so browsers stop re-downloading the same card image on every
  // re-render instead of serving it from cache.
  const { error } = await supabase.storage.from("card-images").upload(fileName, bytes, {
    contentType: mimeType,
    cacheControl: "31536000",
    upsert: true,
  });
  if (error) throw new Error(`Storage upload failed: ${error.message}`);
}

export async function saveImageRecord(
  state,
  { cardItemId, side, dataUrl, fileName, skipSupabaseUpload = false },
) {
  await ensureDiskDir();
  const { mimeType, bytes } = parseDataUrl(dataUrl);
  const imageId = createId(state, "img");
  const extension = extensionFromMime(mimeType, path.extname(fileName || "").slice(1) || "png");
  const safeName = `${imageId}-${side}.${extension}`;
  const diskPath = path.join(imagesDir, safeName);
  await fs.writeFile(diskPath, bytes);

  let storageUrl = null;
  if (process.env.SUPABASE_URL && !skipSupabaseUpload) {
    try {
      await uploadToSupabase(safeName, bytes, mimeType);
      storageUrl = `${process.env.SUPABASE_URL}/storage/v1/object/public/card-images/${safeName}`;
    } catch {
      // fall back to disk serving
    }
  }

  return {
    id: imageId,
    cardItemId,
    side,
    fileName: fileName || safeName,
    mimeType,
    storagePath: diskPath,
    url: storageUrl || `/files/${safeName}`,
    byteLength: bytes.length,
    createdAt: nowIso(),
  };
}
