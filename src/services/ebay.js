function fakeId(prefix) {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

function getConfig() {
  const environment = process.env.EBAY_ENV === "sandbox" ? "sandbox" : "production";
  const baseUrl = environment === "sandbox" ? "https://api.sandbox.ebay.com" : "https://api.ebay.com";
  return {
    environment,
    baseUrl,
    userAccessToken: process.env.EBAY_USER_ACCESS_TOKEN || process.env.EBAY_USER_TOKEN || "",
    marketplaceId: process.env.EBAY_MARKETPLACE_ID || "EBAY_US",
    merchantLocationKey: process.env.EBAY_MERCHANT_LOCATION_KEY || "",
    categoryId: process.env.EBAY_CATEGORY_ID || "",
    paymentPolicyId: process.env.EBAY_PAYMENT_POLICY_ID || "",
    fulfillmentPolicyId: process.env.EBAY_FULFILLMENT_POLICY_GROUND_ADVANTAGE_ID || process.env.EBAY_FULFILLMENT_POLICY_ID || "",
    lessThan20FulfillmentPolicyId: process.env.EBAY_FULFILLMENT_POLICY_LESS_THAN_20_ID || "",
    lessThan20MachinableFulfillmentPolicyId: process.env.EBAY_FULFILLMENT_POLICY_LESS_THAN_20_MACHINEABLE_ID || "",
    returnPolicyId: process.env.EBAY_RETURN_POLICY_ID || ""
  };
}

function hasLiveConfig() {
  const config = getConfig();
  return Boolean(
    config.userAccessToken &&
    config.merchantLocationKey &&
    config.categoryId &&
    config.paymentPolicyId &&
    config.fulfillmentPolicyId &&
    config.lessThan20FulfillmentPolicyId &&
    config.lessThan20MachinableFulfillmentPolicyId &&
    config.returnPolicyId
  );
}

function getCardPrice(card) {
  const rawPrice = card.recommendedPrice ?? card.price ?? 0;
  const price = Number(rawPrice);
  return Number.isFinite(price) ? price : 0;
}

function isThickCard(card) {
  return Boolean(
    card.isThick ||
    card.isThickCard ||
    card.cardThickness === "thick" ||
    card.thickness === "thick" ||
    card.thicknessClass === "thick"
  );
}

function getFulfillmentPolicyIdForCard(card) {
  const config = getConfig();
  const price = getCardPrice(card);
  if (price >= 20) {
    return config.fulfillmentPolicyId;
  }
  if (isThickCard(card)) {
    return config.lessThan20MachinableFulfillmentPolicyId || config.lessThan20FulfillmentPolicyId || config.fulfillmentPolicyId;
  }
  return config.lessThan20FulfillmentPolicyId || config.fulfillmentPolicyId;
}

function buildTitle(card) {
  const parts = [
    card.candidateYear || card.year || "",
    card.candidateSetName || card.setName || "",
    card.candidatePlayer || card.playerName || "",
    card.candidateCardNumber || card.cardNumber || ""
  ].filter(Boolean);
  return parts.join(" ");
}

function buildDescription(card) {
  return [
    buildTitle(card),
    card.candidateParallel ? `Parallel: ${card.candidateParallel}` : null,
    card.candidateGrade ? `Grade: ${card.candidateGrade}` : null,
    card.notes ? `Notes: ${card.notes}` : null
  ]
    .filter(Boolean)
    .join("\n");
}

function mapCondition(card) {
  return card.candidateCondition === "graded" ? "LIKE_NEW" : "USED_VERY_GOOD";
}

async function requestEbay(pathname, { method = "GET", body, contentLanguage = "en-US" } = {}) {
  const config = getConfig();
  const url = `${config.baseUrl}${pathname}`;
  const headers = {
    Authorization: `Bearer ${config.userAccessToken}`,
    Accept: "application/json"
  };
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
  }
  if (contentLanguage) {
    headers["Content-Language"] = contentLanguage;
  }

  const response = await fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
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

  if (!response.ok) {
    const message = payload?.message || payload?.errors?.[0]?.message || text || `HTTP ${response.status}`;
    throw new Error(`eBay ${method} ${pathname} failed (${response.status}): ${message}`);
  }

  return payload;
}

async function createInventoryItem(card) {
  const config = getConfig();
  const sku = card.sku;
  const body = {
    condition: mapCondition(card),
    availability: {
      shipToLocationAvailability: {
        quantity: 1
      }
    },
    product: {
      title: buildTitle(card),
      description: buildDescription(card)
    }
  };
  await requestEbay(`/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`, {
    method: "PUT",
    body,
    contentLanguage: "en-US"
  });
  return {
    sku,
    marketplaceId: config.marketplaceId,
    title: buildTitle(card)
  };
}

async function createLiveOffers(cardItems) {
  const config = getConfig();
  for (const card of cardItems) {
    await createInventoryItem(card);
  }

  const requests = cardItems.map((card) => ({
    sku: card.sku,
    marketplaceId: config.marketplaceId,
    format: "FIXED_PRICE",
    availableQuantity: 1,
    categoryId: config.categoryId,
    merchantLocationKey: config.merchantLocationKey,
    listingDescription: buildDescription(card),
    listingPolicies: {
      paymentPolicyId: config.paymentPolicyId,
      fulfillmentPolicyId: getFulfillmentPolicyIdForCard(card),
      returnPolicyId: config.returnPolicyId
    },
    pricingSummary: {
      price: {
        currency: "USD",
        value: String(card.recommendedPrice ?? 0)
      }
    },
    quantityLimitPerBuyer: 1,
    includeCatalogProductDetails: true
  }));

  const payload = await requestEbay("/sell/inventory/v1/bulk_create_offer", {
    method: "POST",
    body: { requests },
    contentLanguage: "en-US"
  });

  return payload.responses.map((response, index) => ({
    ebayOfferId: response.offerId,
    inventoryItemId: cardItems[index].sku,
    sku: cardItems[index].sku,
    status: response.statusCode === 200 ? "created" : "failed",
    listingId: response.listingId || null,
    requestPayload: requests[index],
    rawResponse: response
  }));
}

async function updateLiveOfferPrices(offers) {
  const updated = [];
  for (const offer of offers) {
    const requestPayload = offer.requestPayload || {};
    const isThick = offer.isThickCard ?? false;
    const price = getCardPrice(offer);
    const listingPolicies = {
      paymentPolicyId: requestPayload.listingPolicies?.paymentPolicyId || getConfig().paymentPolicyId,
      fulfillmentPolicyId: getFulfillmentPolicyIdForCard({
        ...offer,
        recommendedPrice: price,
        isThickCard: isThick
      }),
      returnPolicyId: requestPayload.listingPolicies?.returnPolicyId || getConfig().returnPolicyId
    };
    const body = {
      ...requestPayload,
      sku: offer.sku,
      marketplaceId: requestPayload.marketplaceId || getConfig().marketplaceId,
      format: requestPayload.format || "FIXED_PRICE",
      availableQuantity: requestPayload.availableQuantity ?? 1,
      categoryId: requestPayload.categoryId || getConfig().categoryId,
      merchantLocationKey: requestPayload.merchantLocationKey || getConfig().merchantLocationKey,
      listingDescription: requestPayload.listingDescription || "",
      listingPolicies,
      pricingSummary: {
        ...(requestPayload.pricingSummary || {}),
        price: {
          currency: "USD",
          value: String(price)
        }
      }
    };

    if (offer.ebayOfferId) {
      const response = await requestEbay(`/sell/inventory/v1/offer/${encodeURIComponent(offer.ebayOfferId)}`, {
        method: "PUT",
        body,
        contentLanguage: "en-US"
      });
      updated.push({
        ...offer,
        status: offer.status,
        syncedAt: new Date().toISOString(),
        requestPayload: body,
        rawResponse: response
      });
      continue;
    }

    updated.push({
      ...offer,
      status: "updated",
      syncedAt: new Date().toISOString(),
      requestPayload: body
    });
  }
  return updated;
}

async function publishLiveOffers(offers) {
  const payload = await requestEbay("/sell/inventory/v1/bulk_publish_offer", {
    method: "POST",
    body: {
      requests: offers.map((offer) => ({
        offerId: offer.ebayOfferId
      }))
    }
  });

  return payload.responses.map((response, index) => ({
    ...offers[index],
    status: response.statusCode === 200 ? "published" : "failed",
    listingUrl: response.listingId ? `https://www.ebay.com/itm/${response.listingId}` : null,
    publishedAt: new Date().toISOString(),
    rawResponse: response
  }));
}

export async function createDraftOffers(cardItems) {
  if (!hasLiveConfig()) {
    return cardItems.map((item) => ({
      ebayOfferId: fakeId("offer"),
      inventoryItemId: fakeId("inv"),
      sku: item.sku,
      status: "created",
      requestPayload: {
        sku: item.sku,
        marketplaceId: getConfig().marketplaceId,
        format: "FIXED_PRICE",
        availableQuantity: 1,
        categoryId: getConfig().categoryId || null,
        listingDescription: buildDescription(item),
        listingPolicies: {
          paymentPolicyId: getConfig().paymentPolicyId || null,
          fulfillmentPolicyId: getFulfillmentPolicyIdForCard(item),
          returnPolicyId: getConfig().returnPolicyId || null
        },
        pricingSummary: {
          price: {
            currency: "USD",
            value: String(item.recommendedPrice ?? 0)
          }
        }
      }
    }));
  }

  return createLiveOffers(cardItems);
}

export async function updateOfferPrices(offers) {
  if (!hasLiveConfig()) {
    return offers.map((offer) => ({
      ...offer,
      status: "updated",
      syncedAt: new Date().toISOString()
    }));
  }

  return updateLiveOfferPrices(offers);
}

export async function publishOffers(offers) {
  if (!hasLiveConfig()) {
    return offers.map((offer) => ({
      ...offer,
      status: "published",
      listingUrl: `https://www.ebay.com/itm/${fakeId("listing")}`,
      publishedAt: new Date().toISOString()
    }));
  }

  return publishLiveOffers(offers);
}

export function getEbayConfig() {
  const config = getConfig();
  return {
    environment: config.environment,
    marketplaceId: config.marketplaceId,
    hasLiveConfig: hasLiveConfig(),
    fulfillmentPolicies: {
      groundAdvantage: config.fulfillmentPolicyId || null,
      lessThan20: config.lessThan20FulfillmentPolicyId || null,
      lessThan20Machinable: config.lessThan20MachinableFulfillmentPolicyId || null
    }
  };
}
