import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createId, nowIso } from "./store.js";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const dataDir = path.join(rootDir, "data");
const imagesDir = path.join(dataDir, "images");

export async function ensureStorage() {
  await fs.mkdir(imagesDir, { recursive: true });
}

function parseDataUrl(dataUrl) {
  const match = /^data:(.+?);base64,(.+)$/i.exec(dataUrl);
  if (!match) {
    throw new Error("Expected a data URL image");
  }
  return {
    mimeType: match[1],
    bytes: Buffer.from(match[2], "base64")
  };
}

function extensionFromMime(mimeType, fallback = "png") {
  if (mimeType.includes("jpeg")) return "jpg";
  if (mimeType.includes("png")) return "png";
  if (mimeType.includes("webp")) return "webp";
  return fallback;
}

export async function saveImageRecord(state, { cardItemId, side, dataUrl, fileName }) {
  await ensureStorage();
  const { mimeType, bytes } = parseDataUrl(dataUrl);
  const imageId = createId(state, "img");
  const extension = extensionFromMime(mimeType, path.extname(fileName || "").slice(1) || "png");
  const safeName = `${imageId}-${side}.${extension}`;
  const filePath = path.join(imagesDir, safeName);
  await fs.writeFile(filePath, bytes);
  return {
    id: imageId,
    cardItemId,
    side,
    fileName: fileName || safeName,
    mimeType,
    storagePath: filePath,
    url: `/files/${safeName}`,
    byteLength: bytes.length,
    createdAt: nowIso()
  };
}

