'use server';
// Sanar y Criar: provider-agnostic checkout, order and access calls.
// Contract: docs/spec-tecnica.md section 2.3. Every call returns
// getResponseMetadata ({success, data, status}) so callers can read the
// backend `detail` (e.g. {code: 'ALREADY_OWNED'}) instead of a stripped error.
import { getAPIUrl } from '@services/config/config';
import { RequestBodyWithAuthHeader, getResponseMetadata, secureFetch } from '@services/utils/ts/requests';

const paymentsBase = (orgId: number) => `${getAPIUrl()}payments/${encodeURIComponent(String(orgId))}`;

export type CheckoutMethod = 'paypal' | 'card';

/** Active payment providers, public: [{provider, label, environment, client_id, methods, currencies}]. */
export async function getCheckoutProviders(orgId: number) {
  const result = await secureFetch(
    `${paymentsBase(orgId)}/checkout/providers`,
    RequestBodyWithAuthHeader('GET', null, null, '')
  );
  return getResponseMetadata(result);
}

/** Starts a redirect checkout. Success: {checkout_url, provider, order_uuid}. */
export async function startOfferCheckout(
  orgId: number,
  offerId: string,
  params: { redirect_uri: string; provider: string; method: CheckoutMethod },
  access_token: string
) {
  const query = new URLSearchParams({
    redirect_uri: params.redirect_uri,
    provider: params.provider,
    method: params.method,
  });
  const result = await secureFetch(
    `${paymentsBase(orgId)}/offers/${encodeURIComponent(offerId)}/checkout?${query}`,
    RequestBodyWithAuthHeader('POST', null, null, access_token)
  );
  return getResponseMetadata(result);
}

/** Captures (idempotently) an approved order: {status, order_uuid, offer_uuid, resources}. */
export async function captureOrder(orgId: number, orderUuid: string, access_token?: string | null) {
  const result = await secureFetch(
    `${paymentsBase(orgId)}/orders/${encodeURIComponent(orderUuid)}/capture`,
    RequestBodyWithAuthHeader('POST', null, null, access_token || '')
  );
  return getResponseMetadata(result);
}

/** Order status, for polling while a payment is pending. */
export async function getOrderStatus(orgId: number, orderUuid: string, access_token: string) {
  const result = await secureFetch(
    `${paymentsBase(orgId)}/orders/${encodeURIComponent(orderUuid)}`,
    RequestBodyWithAuthHeader('GET', null, null, access_token)
  );
  return getResponseMetadata(result);
}

/** Marks an unpaid order as cancelled (buyer came back with ?checkout=cancelled). */
export async function cancelOrder(orgId: number, orderUuid: string, access_token: string) {
  const result = await secureFetch(
    `${paymentsBase(orgId)}/orders/${encodeURIComponent(orderUuid)}/cancel`,
    RequestBodyWithAuthHeader('POST', null, null, access_token)
  );
  return getResponseMetadata(result);
}

/**
 * Whether the current viewer can open a resource:
 * {for_sale, has_access, reason: 'free'|'purchased'|'admin'|'author'|'anonymous'|'none', offers_count}.
 */
export async function getResourceAccess(orgId: number, resourceUuid: string, access_token?: string | null) {
  const result = await secureFetch(
    `${paymentsBase(orgId)}/access?resource_uuid=${encodeURIComponent(resourceUuid)}`,
    RequestBodyWithAuthHeader('GET', null, null, access_token || '')
  );
  return getResponseMetadata(result);
}
