import { getEbayConfig, refreshEbayToken } from "./ebay.js";

function getConfig() {
  const environment = process.env.EBAY_ENV === "sandbox" ? "sandbox" : "production";
  const baseUrl =
    environment === "sandbox" ? "https://api.sandbox.ebay.com" : "https://api.ebay.com";
  const runtime = getEbayConfig();
  return {
    environment,
    baseUrl,
    userAccessToken: runtime.userAccessToken || process.env.EBAY_USER_ACCESS_TOKEN || process.env.EBAY_USER_TOKEN || "",
    marketplaceId: runtime.marketplaceId || process.env.EBAY_MARKETPLACE_ID || "EBAY_US",
  };
}

async function requestEbay(pathname) {
  const config = getConfig();
  const response = await fetch(`${config.baseUrl}${pathname}`, {
    headers: {
      Authorization: `Bearer ${config.userAccessToken}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      "Content-Language": "en-US",
      "Accept-Language": "en-US",
      "X-EBAY-C-MARKETPLACE-ID": config.marketplaceId || "EBAY_US",
    },
  });
  const text = await response.text();
  let payload = {};
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { raw: text };
    }
  }
  if (response.status === 401) {
    const rt = getEbayConfig().refreshToken;
    if (rt) {
      await refreshEbayToken();
      return requestEbay(pathname);
    }
  }
  if (!response.ok) {
    const message =
      payload?.message || payload?.errors?.[0]?.message || text || `HTTP ${response.status}`;
    throw new Error(`eBay GET ${pathname} failed (${response.status}): ${message}`);
  }
  return payload;
}

export async function fetchEbaySetup() {
  const config = getConfig();
  if (!config.userAccessToken) {
    throw new Error("Missing EBAY_USER_ACCESS_TOKEN");
  }

  const [locations, paymentPolicies, fulfillmentPolicies, returnPolicies] = await Promise.all([
    requestEbay("/sell/inventory/v1/location?limit=25&offset=0"),
    requestEbay(
      `/sell/account/v1/payment_policy?marketplace_id=${encodeURIComponent(config.marketplaceId)}`,
    ),
    requestEbay(
      `/sell/account/v1/fulfillment_policy?marketplace_id=${encodeURIComponent(config.marketplaceId)}`,
    ),
    requestEbay(
      `/sell/account/v1/return_policy?marketplace_id=${encodeURIComponent(config.marketplaceId)}`,
    ),
  ]);

  return {
    environment: config.environment,
    marketplaceId: config.marketplaceId,
    merchantLocationKey: locations.locations?.[0]?.merchantLocationKey || null,
    locations: locations.locations || [],
    paymentPolicies: paymentPolicies.paymentPolicies || [],
    fulfillmentPolicies: fulfillmentPolicies.fulfillmentPolicies || [],
    returnPolicies: returnPolicies.returnPolicies || [],
  };
}
