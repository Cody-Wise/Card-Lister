import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { google } from "googleapis";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const TOKEN_FILE = path.join(rootDir, "data", "drive-tokens.json");
const DRIVE_CALLBACK_PATH = "/api/drive/callback";

let cachedTokens = null;

const DRIVE_WRITE_SCOPES = new Set(["https://www.googleapis.com/auth/drive", "https://www.googleapis.com/auth/drive.file"]);

function hasDriveWriteScope(tokens) {
  const scope = (tokens?.scope || "").toString();
  return scope === "*" || Array.from(DRIVE_WRITE_SCOPES).some((candidate) => scope.includes(candidate));
}

function hasDriveReadScope(tokens) {
  const scope = (tokens?.scope || "").toString();
  return (
    scope === "*" ||
    scope.includes("https://www.googleapis.com/auth/drive") ||
    scope.includes("https://www.googleapis.com/auth/drive.file") ||
    scope.includes("https://www.googleapis.com/auth/drive.readonly")
  );
}

function ensureDriveWriteScope(tokens) {
  if (!hasDriveWriteScope(tokens)) {
    throw new Error(
      "Drive token missing write scope. Reconnect and grant Google Drive access (not read-only) to allow folder moves.",
    );
  }
}

function getDriveRedirectUri(req) {
  if (process.env.GOOGLE_DRIVE_REDIRECT_URI) return process.env.GOOGLE_DRIVE_REDIRECT_URI;
  const host = req?.headers?.host || "localhost:3000";
  const proto = req?.headers?.["x-forwarded-proto"] || "http";
  return `${proto}://${host}${DRIVE_CALLBACK_PATH}`;
}

function getOAuth2Client(reqOrRedirectUri) {
  const clientId = process.env.GOOGLE_DRIVE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_DRIVE_CLIENT_SECRET;
  const redirectUri =
    typeof reqOrRedirectUri === "string" ? reqOrRedirectUri : getDriveRedirectUri(reqOrRedirectUri);
  if (!clientId || !clientSecret) return null;
  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}

function getDriveClient(auth) {
  return google.drive({ version: "v3", auth });
}

async function loadTokens() {
  if (cachedTokens) return cachedTokens;
  try {
    const raw = await fs.readFile(TOKEN_FILE, "utf8");
    cachedTokens = JSON.parse(raw);
    return cachedTokens;
  } catch {
    return null;
  }
}

async function saveTokens(tokens) {
  cachedTokens = tokens;
  await fs.mkdir(path.dirname(TOKEN_FILE), { recursive: true });
  await fs.writeFile(TOKEN_FILE, JSON.stringify(tokens, null, 2));
}

export function getAuthUrl(req) {
  const oauth2 = getOAuth2Client(req);
  if (!oauth2) return null;
  return oauth2.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: false,
    scope: ["https://www.googleapis.com/auth/drive"],
  });
}

export function hasDriveConfig() {
  return Boolean(process.env.GOOGLE_DRIVE_CLIENT_ID && process.env.GOOGLE_DRIVE_CLIENT_SECRET);
}

export async function isConnected() {
  const tokens = await loadTokens();
  if (!tokens || !tokens.access_token) return false;
  return hasDriveWriteScope(tokens);
}

export async function getDriveStatus() {
  const tokens = await loadTokens();
  if (!tokens || !tokens.access_token) {
    return {
      connected: false,
      hasToken: false,
      hasWriteScope: false,
      hasReadScope: false,
      statusMessage: "Not connected",
    };
  }
  const hasWriteScope = hasDriveWriteScope(tokens);
  return {
    connected: hasWriteScope,
    hasToken: true,
    hasWriteScope,
    hasReadScope: hasDriveReadScope(tokens),
    statusMessage: hasWriteScope ? "Connected (read/write)" : "Connected (read-only)",
  };
}

export async function handleCallback(code, req) {
  const oauth2 = getOAuth2Client(req);
  if (!oauth2) throw new Error("Drive not configured");
  const { tokens } = await oauth2.getToken(code);
  ensureDriveWriteScope(tokens);
  await saveTokens(tokens);
  return tokens;
}

export async function disconnect() {
  cachedTokens = null;
  try {
    await fs.unlink(TOKEN_FILE);
  } catch {
    // ignore
  }
}

function baseName(fileName) {
  const name = path.basename(fileName, path.extname(fileName));
  const match = name.match(/^(.*?)(\d+)$/);
  if (!match) return null;
  return { base: match[1], num: parseInt(match[2], 10) };
}

export function matchPairs(files) {
  const imageFiles = files.filter((f) => {
    const ext = path.extname(f.name).toLowerCase();
    return [".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp", ".tiff", ".tif"].includes(ext);
  });
  const indexed = [];
  const orphans = [];
  for (const file of imageFiles) {
    const info = baseName(file.name);
    if (!info || (info.num !== 1 && info.num !== 2)) {
      orphans.push(file);
      continue;
    }
    indexed.push({ ...file, base: info.base, num: info.num });
  }
  const groups = new Map();
  for (const item of indexed) {
    if (!groups.has(item.base)) groups.set(item.base, {});
    groups.get(item.base)[item.num === 1 ? "front" : "back"] = item;
  }
  const pairs = [];
  const unmatched = [...orphans];
  for (const [base, pair] of groups) {
    if (pair.front && pair.back) {
      pairs.push({ base, front: pair.front, back: pair.back });
    } else {
      if (pair.front) unmatched.push(pair.front);
      if (pair.back) unmatched.push(pair.back);
    }
  }
  return { pairs, unmatched };
}

export async function listFolder(folderId) {
  const tokens = await loadTokens();
  if (!tokens) throw new Error("Not authenticated");

  const oauth2 = getOAuth2Client();
  oauth2.setCredentials(tokens);
  oauth2.on("tokens", async (newTokens) => {
    const merged = { ...tokens, ...newTokens };
    await saveTokens(merged);
  });

  const drive = getDriveClient(oauth2);
  let allFiles = [];
  let pageToken = null;

  do {
    const res = await drive.files.list({
      q: `'${folderId}' in parents and trashed = false`,
      fields: "nextPageToken, files(id, name, mimeType, size)",
      pageSize: 200,
      pageToken,
    });
    allFiles = allFiles.concat(res.data.files);
    pageToken = res.data.nextPageToken;
  } while (pageToken);

  return allFiles;
}

export async function downloadFile(fileId) {
  const tokens = await loadTokens();
  if (!tokens) throw new Error("Not authenticated");

  const oauth2 = getOAuth2Client();
  oauth2.setCredentials(tokens);
  oauth2.on("tokens", async (newTokens) => {
    const merged = { ...tokens, ...newTokens };
    await saveTokens(merged);
  });

  const drive = getDriveClient(oauth2);
  const res = await drive.files.get({ fileId, alt: "media" }, { responseType: "arraybuffer" });
  return Buffer.from(res.data);
}

export async function createFolder(parentFolderId, folderName) {
  const tokens = await loadTokens();
  if (!tokens) throw new Error("Not authenticated");
  ensureDriveWriteScope(tokens);

  const oauth2 = getOAuth2Client();
  oauth2.setCredentials(tokens);
  oauth2.on("tokens", async (newTokens) => {
    const merged = { ...tokens, ...newTokens };
    await saveTokens(merged);
  });

  const drive = getDriveClient(oauth2);
  const res = await drive.files.create({
    requestBody: {
      name: folderName,
      mimeType: "application/vnd.google-apps.folder",
      parents: [parentFolderId],
    },
    fields: "id, name",
  });
  return res.data;
}

export async function moveFile(fileId, newParentId) {
  const tokens = await loadTokens();
  if (!tokens) throw new Error("Not authenticated");
  ensureDriveWriteScope(tokens);

  const oauth2 = getOAuth2Client();
  oauth2.setCredentials(tokens);
  oauth2.on("tokens", async (newTokens) => {
    const merged = { ...tokens, ...newTokens };
    await saveTokens(merged);
  });

  const drive = getDriveClient(oauth2);

  const file = await drive.files.get({
    fileId,
    fields: "parents",
  });
  const previousParents = file.data.parents.join(",");

  await drive.files.update({
    fileId,
    addParents: newParentId,
    removeParents: previousParents,
    fields: "id, parents",
  });
}

export async function getFileInfo(fileId) {
  const tokens = await loadTokens();
  if (!tokens) throw new Error("Not authenticated");
  ensureDriveWriteScope(tokens);

  const oauth2 = getOAuth2Client();
  oauth2.setCredentials(tokens);

  const drive = getDriveClient(oauth2);
  const res = await drive.files.get({
    fileId,
    fields: "id, name, mimeType, size, parents",
  });
  return res.data;
}

export async function renameFile(fileId, newName) {
  const tokens = await loadTokens();
  if (!tokens) throw new Error("Not authenticated");
  ensureDriveWriteScope(tokens);

  const oauth2 = getOAuth2Client();
  oauth2.setCredentials(tokens);
  oauth2.on("tokens", async (newTokens) => {
    const merged = { ...tokens, ...newTokens };
    await saveTokens(merged);
  });

  const drive = getDriveClient(oauth2);
  const res = await drive.files.update({
    fileId,
    requestBody: { name: newName },
    fields: "id, name",
  });
  return res.data;
}
