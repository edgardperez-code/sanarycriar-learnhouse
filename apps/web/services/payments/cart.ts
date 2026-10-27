'use server';
// Sanar y Criar: cart and Pago Móvil order calls (contract §B.2, §D.2).
// Every call returns getResponseMetadata ({success, data, status}) and never
// throws on an HTTP error, so callers can read the backend `detail`
// ({code, message, ...}) of a 4xx.
import { getAPIUrl } from '@services/config/config';
import { RequestBodyWithAuthHeader, getResponseMetadata, secureFetch } from '@services/utils/ts/requests';

const paymentsBase = (orgId: number) => `${getAPIUrl()}payments/${encodeURIComponent(String(orgId))}`;

/** Prices, status of each product and the total in US$ and Bs. Public (uses the session when there is one). */
export async function getCartQuote(orgId: number, offerUuids: string[], access_token?: string | null) {
  const result = await secureFetch(
    `${paymentsBase(orgId)}/cart/quote`,
    RequestBodyWithAuthHeader('POST', { offer_uuids: offerUuids }, null, access_token || '')
  );
  return getResponseMetadata(result);
}

/** Creates the order (HTTP 201 with the Purchase). Only Pago Móvil goes through the cart. */
export async function checkoutCart(orgId: number, offerUuids: string[], access_token: string) {
  const result = await secureFetch(
    `${paymentsBase(orgId)}/cart/checkout`,
    RequestBodyWithAuthHeader(
      'POST',
      { offer_uuids: offerUuids, provider: 'manual', method: 'pago_movil' },
      null,
      access_token
    )
  );
  return getResponseMetadata(result);
}

/** The buyer's orders, most recent first: {items: Purchase[]}. */
export async function getMyPurchases(orgId: number, access_token: string) {
  const result = await secureFetch(
    `${paymentsBase(orgId)}/purchases/mine`,
    RequestBodyWithAuthHeader('GET', null, null, access_token)
  );
  return getResponseMetadata(result);
}

/** One order of the buyer (404 when it is not theirs). */
export async function getPurchase(orgId: number, purchaseUuid: string, access_token: string) {
  const result = await secureFetch(
    `${paymentsBase(orgId)}/purchases/${encodeURIComponent(purchaseUuid)}`,
    RequestBodyWithAuthHeader('GET', null, null, access_token)
  );
  return getResponseMetadata(result);
}

/** The buyer cancels an unpaid order. */
export async function cancelPurchase(orgId: number, purchaseUuid: string, access_token: string) {
  const result = await secureFetch(
    `${paymentsBase(orgId)}/purchases/${encodeURIComponent(purchaseUuid)}/cancel`,
    RequestBodyWithAuthHeader('POST', null, null, access_token)
  );
  return getResponseMetadata(result);
}
