'use server';
// Sanar y Criar: Pago Móvil orders (cart purchases) and the Pago Móvil
// settings, for the dashboard. Contract: cart contract §B.2. Every call
// returns {success, data, status} and never throws, so the page can read the
// API's `detail` ({code, message, ...}) for REFERENCE_USED, INVALID_FIELD, ….
import { getAPIUrl } from '@services/config/config';
import { RequestBodyWithAuthHeader, getResponseMetadata, secureFetch } from '@services/utils/ts/requests';
import {
  buildListParams,
  normalizeReference,
  type ConfirmBody,
  type ManualSettingsBody,
  type RejectBody,
  type VoidBody,
} from '@components/Dashboard/Pages/Orders/ordersForm';

type Result = { success: boolean; data: any; status: number; HTTPmessage: string };

function paymentsUrl(orgId: number, path: string) {
  return `${getAPIUrl()}payments/${encodeURIComponent(String(orgId))}/${path}`;
}

function purchasePath(purchaseUuid: string, suffix = '') {
  return `purchases/${encodeURIComponent(String(purchaseUuid))}${suffix}`;
}

async function call(orgId: number, path: string, method: string, body: any, access_token: string): Promise<Result> {
  try {
    const result = await secureFetch(paymentsUrl(orgId, path), RequestBodyWithAuthHeader(method, body, null, access_token));
    return await getResponseMetadata(result);
  } catch {
    // Network failure: the page shows its generic error.
    return { success: false, data: null, status: 0, HTTPmessage: 'network error' };
  }
}

export async function getManualSettings(orgId: number, access_token: string) {
  return call(orgId, 'manual/settings', 'GET', null, access_token);
}

export async function updateManualSettings(orgId: number, body: ManualSettingsBody, access_token: string) {
  return call(orgId, 'manual/settings', 'PUT', body ?? {}, access_token);
}

export async function getPurchasesAdmin(
  orgId: number,
  params: { status?: string; q?: string; limit?: number; offset?: number },
  access_token: string
) {
  const query = new URLSearchParams(buildListParams(params ?? {}));
  return call(orgId, `purchases?${query.toString()}`, 'GET', null, access_token);
}

export async function getPurchasesSummary(orgId: number, access_token: string) {
  return call(orgId, 'purchases/summary', 'GET', null, access_token);
}

export async function getPurchaseAdmin(orgId: number, purchaseUuid: string, access_token: string) {
  return call(orgId, purchasePath(purchaseUuid), 'GET', null, access_token);
}

export async function confirmPurchase(orgId: number, purchaseUuid: string, body: ConfirmBody, access_token: string) {
  const note = (body?.note ?? '').trim();
  const payload: ConfirmBody = {
    bank_reference: normalizeReference(body?.bank_reference),
    ...(note ? { note } : {}),
    ...(body?.allow_reused_reference ? { allow_reused_reference: true } : {}),
  };
  return call(orgId, purchasePath(purchaseUuid, '/confirm'), 'POST', payload, access_token);
}

export async function rejectPurchase(orgId: number, purchaseUuid: string, body: RejectBody, access_token: string) {
  const payload: RejectBody = { reason: (body?.reason ?? '').trim(), notify: body?.notify !== false };
  return call(orgId, purchasePath(purchaseUuid, '/reject'), 'POST', payload, access_token);
}

export async function voidPurchase(orgId: number, purchaseUuid: string, body: VoidBody, access_token: string) {
  const payload: VoidBody = { reason: (body?.reason ?? '').trim() };
  return call(orgId, purchasePath(purchaseUuid, '/void'), 'POST', payload, access_token);
}
