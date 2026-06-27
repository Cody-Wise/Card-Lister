import { promises as fs } from "node:fs";
import path from "node:path";

function parseEnvLine(line) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return null;

  const equalsIndex = trimmed.indexOf("=");
  if (equalsIndex === -1) return null;

  const key = trimmed.slice(0, equalsIndex).trim();
  let value = trimmed.slice(equalsIndex + 1).trim();

  if (!key) return null;

  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }

  value = value.replace(/\\n/g, "\n");
  return { key, value };
}

export async function loadEnvFile(envPath = path.resolve(process.cwd(), ".env")) {
  try {
    const raw = await fs.readFile(envPath, "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const entry = parseEnvLine(line);
      if (!entry) continue;
      if (!(entry.key in process.env)) {
        process.env[entry.key] = entry.value;
      }
    }
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}
