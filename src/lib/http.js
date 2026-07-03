const DEFAULT_MAX_REQUEST_BYTES = 50 * 1024 * 1024;

function maxRequestBytes() {
  const parsed = Number(process.env.MAX_REQUEST_BYTES);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_REQUEST_BYTES;
}

function tooLarge(maxBytes) {
  const error = new Error(`Request body exceeds ${maxBytes} bytes`);
  error.statusCode = 413;
  return error;
}

export async function readJson(req, { maxBytes = maxRequestBytes() } = {}) {
  // Reject up front when the client declares an oversized body, so we can send a
  // clean 413 without draining the stream.
  const declaredLength = Number(req.headers["content-length"]);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw tooLarge(maxBytes);
  }

  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) {
      // Defense in depth for chunked/unlabelled bodies that exceed the cap.
      throw tooLarge(maxBytes);
    }
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    const error = new Error("Request body is not valid JSON");
    error.statusCode = 400;
    throw error;
  }
}

export function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

export function sendText(res, statusCode, body, contentType = "text/plain; charset=utf-8") {
  res.writeHead(statusCode, { "Content-Type": contentType });
  res.end(body);
}

export function notFound(res, message = "Not found") {
  sendJson(res, 404, { error: message });
}
