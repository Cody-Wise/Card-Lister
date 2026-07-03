import crypto from "node:crypto";

const SESSION_COOKIE = "session";
const SESSION_MAX_AGE = 7 * 24 * 60 * 60;

function getSessionSecret() {
  return process.env.SESSION_SECRET || "dev-secret-change-me";
}

// ADMIN_EMAIL supports a comma-separated list, e.g. "a@x.com,b@x.com".
function getAdminEmails() {
  return (process.env.ADMIN_EMAIL || "")
    .split(",")
    .map((email) => email.toLowerCase().trim())
    .filter(Boolean);
}

// True when no allowlist is configured (open access) or the email is on it.
export function isAllowedEmail(email) {
  const admins = getAdminEmails();
  if (!admins.length) return true;
  return admins.includes(String(email || "").toLowerCase().trim());
}

function sign(payload) {
  return crypto.createHmac("sha256", getSessionSecret()).update(payload).digest("hex");
}

export function createSession(email) {
  const exp = Date.now() + SESSION_MAX_AGE * 1000;
  const payload = `${email}:${exp}`;
  const sig = sign(payload);
  return Buffer.from(JSON.stringify({ email, exp, sig })).toString("base64url");
}

export function verifySession(cookieValue) {
  try {
    const decoded = JSON.parse(Buffer.from(cookieValue, "base64url").toString("utf8"));
    const { email, exp, sig } = decoded;
    if (!email || !exp || !sig) return null;
    if (Date.now() > exp) return null;
    const expected = sign(`${email}:${exp}`);
    if (sig !== expected) return null;
    return { email };
  } catch {
    return null;
  }
}

export function getSessionFromRequest(req) {
  const cookies = parseCookies(req.headers.cookie || "");
  const sessionCookie = cookies[SESSION_COOKIE];
  if (!sessionCookie) return null;
  return verifySession(sessionCookie);
}

function parseCookies(cookieHeader) {
  const cookies = {};
  cookieHeader.split(";").forEach((pair) => {
    const [key, ...rest] = pair.trim().split("=");
    if (key) cookies[key.trim()] = decodeURIComponent(rest.join("="));
  });
  return cookies;
}

export function setSessionCookie(res, email) {
  const value = createSession(email);
  const isSecure = process.env.NODE_ENV === "production";
  const attrs = [
    `${SESSION_COOKIE}=${value}`,
    "Path=/",
    `Max-Age=${SESSION_MAX_AGE}`,
    "HttpOnly",
    "SameSite=Lax",
    isSecure ? "Secure" : "",
  ]
    .filter(Boolean)
    .join("; ");
  res.setHeader("Set-Cookie", attrs);
}

export function clearSessionCookie(res) {
  const attrs = [
    `${SESSION_COOKIE}=`,
    "Path=/",
    "Max-Age=0",
    "HttpOnly",
    "SameSite=Lax",
  ].join("; ");
  res.setHeader("Set-Cookie", attrs);
}

export function isAuthenticated(req) {
  const session = getSessionFromRequest(req);
  if (!session) return false;
  if (!isAllowedEmail(session.email)) return false;
  return true;
}

export function getGoogleOAuthUrl(req) {
  const clientId = process.env.GOOGLE_DRIVE_CLIENT_ID;
  const redirectUri = getRedirectUri(req);
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "openid email profile",
    access_type: "offline",
    prompt: "consent",
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

function getRedirectUri(req) {
  const explicit = String(process.env.GOOGLE_AUTH_REDIRECT_URI || "").trim();
  if (explicit) return explicit;
  const host = req.headers.host || "localhost:3000";
  const proto = req.headers["x-forwarded-proto"] || "http";
  return `${proto}://${host}/auth/callback`;
}

export async function exchangeGoogleCode(req, code) {
  const clientId = process.env.GOOGLE_DRIVE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_DRIVE_CLIENT_SECRET;
  const redirectUri = getRedirectUri(req);

  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });

  if (!tokenRes.ok) {
    throw new Error(`Google token exchange failed: ${tokenRes.status}`);
  }

  const tokens = await tokenRes.json();

  const userInfoRes = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });

  if (!userInfoRes.ok) {
    throw new Error(`Google userinfo failed: ${userInfoRes.status}`);
  }

  const userInfo = await userInfoRes.json();
  return { email: userInfo.email, name: userInfo.name };
}
