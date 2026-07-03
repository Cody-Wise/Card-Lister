// eBay OAuth + seller-account config routes — second extraction out of the
// monolithic src/app.js (see README "Known rough edges"), following the same
// approach as src/routes/drive-routes.js: move a self-contained route
// cluster verbatim, verify behaviorally identical, test, then deploy.
import { readJson, sendJson } from "../lib/http.js";
import {
  createEbayAuthUrlState,
  consumeEbayAuthUrlState,
  getEbayAuthUrl,
  exchangeEbayCode,
  refreshEbayToken,
  setEbayConfig,
  getEbayConfig,
} from "../services/ebay.js";
import { fetchEbaySetup } from "../services/ebay-setup.js";

// Returns true if this route matched and was handled (caller should stop
// processing the request), false otherwise — same convention as
// handleDriveApiRoutes()/serveStatic()'s boolean return.
export async function handleEbayOAuthRoutes(req, res, { pathname, url }) {
  if (req.method === "GET" && pathname === "/api/ebay/auth-url") {
    try {
      const requestHint = {
        host: url.host,
        hostname: url.hostname,
        port: url.port,
        protocol: url.protocol,
      };
      const { state, redirectUri } = createEbayAuthUrlState(requestHint);
      const requestedScopeProfile = url.searchParams.get("scopeProfile");
      const scopeProfile = ["base", "minimal", "portal"].includes(requestedScopeProfile)
        ? requestedScopeProfile
        : "default";
      const authUrl = getEbayAuthUrl(requestHint, { state, scopeProfile });
      const acceptHeader = String(req.headers.accept || "");
      const wantsJson =
        url.searchParams.get("format") === "json" || acceptHeader.includes("application/json");
      if (!wantsJson) {
        res.writeHead(302, { Location: authUrl });
        res.end();
      } else {
        sendJson(res, 200, { url: authUrl, callbackUrl: redirectUri, scopeProfile });
      }
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return true;
  }

  if (req.method === "GET" && pathname === "/api/ebay/auth-callback") {
    const query = url.searchParams;
    const callbackError = query.get("error");
    const callbackErrorDescription = query.get("error_description") || "Unknown error";
    const code = query.get("code");
    const state = query.get("state");
    if (callbackError) {
      res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        `<html><body style="font-family: sans-serif; padding: 2rem; background: #08080A; color: #F5F4F0;"><h2>Authorization Failed</h2><p>${callbackError}: ${callbackErrorDescription}</p></body></html>`,
      );
      return true;
    }
    if (!code) {
      sendJson(res, 400, { error: "Missing code parameter" });
      return true;
    }
    let requestHint = null;
    try {
      const redirectUri = state ? consumeEbayAuthUrlState(state) : null;
      requestHint = {
        host: url.host,
        hostname: url.hostname,
        port: url.port,
        protocol: url.protocol,
      };
      if (redirectUri) requestHint.redirectUri = redirectUri;
      exchangeEbayCode(code, requestHint)
        .then((tokens) => {
          setEbayConfig({
            userAccessToken: tokens.access_token,
            refreshToken: tokens.refresh_token,
          });
          console.log("eBay OAuth token exchange completed.");
        })
        .catch((error) => {
          console.error("eBay OAuth token exchange failed:", error.message);
        });
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        `<html><body style="font-family: sans-serif; padding: 2rem; background: #08080A; color: #F5F4F0;"><h2>eBay Authorization Received</h2><p>The app received the eBay authorization code and is finishing token setup in the background.</p><p>Wait a few seconds, then return to Bigfoot Boys Command Center settings and refresh eBay status.</p></body></html>`,
      );
    } catch (error) {
      const callbackRedirectUri = requestHint?.redirectUri || "request-derived";
      res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        `<html><body style="font-family: sans-serif; padding: 2rem; background: #08080A; color: #F5F4F0;"><h2>Authorization Failed</h2><p>${error.message}</p><p style="font-family: monospace; word-break: break-all;">callback_redirect_uri=${callbackRedirectUri}</p></body></html>`,
      );
    }
    return true;
  }

  if (req.method === "POST" && pathname === "/api/ebay/refresh-token") {
    try {
      const { refreshToken } = await readJson(req);
      if (refreshToken) setEbayConfig({ refreshToken });
      const result = await refreshEbayToken();
      sendJson(res, 200, { ok: true, hasRefreshToken: Boolean(result.refresh_token) });
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return true;
  }

  if (req.method === "POST" && pathname === "/api/ebay/reset-auth") {
    try {
      setEbayConfig({
        userAccessToken: "",
        refreshToken: "",
      });
      sendJson(res, 200, { ok: true, reset: true });
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return true;
  }

  if (req.method === "GET" && pathname === "/api/ebay/config") {
    const config = getEbayConfig();
    const hasToken = Boolean(config.userAccessToken);
    const { userAccessToken: _, ...safeConfig } = config;
    const configured = Boolean(
      hasToken &&
        safeConfig.merchantLocationKey &&
        safeConfig.paymentPolicyId &&
        safeConfig.fulfillmentPolicyId &&
        safeConfig.returnPolicyId,
    );
    sendJson(res, 200, { configured, hasToken, config: safeConfig });
    return true;
  }

  if (req.method === "GET" && pathname === "/api/ebay/setup") {
    try {
      const setup = await fetchEbaySetup();
      sendJson(res, 200, setup);
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return true;
  }

  if (req.method === "POST" && pathname === "/api/ebay/auto-configure") {
    try {
      const setup = await fetchEbaySetup();
      if (!setup.merchantLocationKey) {
        sendJson(res, 400, { error: "No merchant location found. Create one in your eBay account settings first." });
        return true;
      }
      if (!setup.paymentPolicies.length) {
        sendJson(res, 400, { error: "No payment policy found. Create one in your eBay account settings first." });
        return true;
      }
      if (!setup.fulfillmentPolicies.length) {
        sendJson(res, 400, { error: "No fulfillment policy found. Create one in your eBay account settings first." });
        return true;
      }
      if (!setup.returnPolicies.length) {
        sendJson(res, 400, { error: "No return policy found. Create one in your eBay account settings first." });
        return true;
      }
      setEbayConfig({
        merchantLocationKey: setup.merchantLocationKey,
        paymentPolicyId: setup.paymentPolicies[0].paymentPolicyId,
        fulfillmentPolicyId: setup.fulfillmentPolicies[0].fulfillmentPolicyId,
        returnPolicyId: setup.returnPolicies[0].returnPolicyId,
        categoryId: process.env.EBAY_CATEGORY_ID || "261328",
      });
      sendJson(res, 200, {
        message: "eBay configured successfully",
        config: {
          merchantLocationKey: setup.merchantLocationKey,
          paymentPolicyId: setup.paymentPolicies[0].paymentPolicyId,
          fulfillmentPolicyId: setup.fulfillmentPolicies[0].fulfillmentPolicyId,
          returnPolicyId: setup.returnPolicies[0].returnPolicyId,
        },
        availablePolicies: {
          locations: setup.locations,
          paymentPolicies: setup.paymentPolicies,
          fulfillmentPolicies: setup.fulfillmentPolicies,
          returnPolicies: setup.returnPolicies,
        },
      });
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return true;
  }

  return false;
}
