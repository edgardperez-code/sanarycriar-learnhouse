'use server';
// Sanar y Criar: PayPal provider configuration (credentials form, no OAuth popup).
//
// These use getResponseMetadata instead of errorHandling: thrown errors lose
// their properties across the server-action boundary in production, and the
// admin needs PayPal's actual validation message ("invalid client id", ...).
import { getAPIUrl } from '@services/config/config';
import { RequestBodyWithAuthHeader, getResponseMetadata, secureFetch } from '@services/utils/ts/requests';

export type PaypalEnvironment = 'sandbox' | 'live';

export interface PaypalConfigInput {
  client_id: string;
  // Omit (or leave empty) on update to keep the stored secret.
  client_secret?: string;
  environment: PaypalEnvironment;
  webhook_id?: string | null;
  enabled?: boolean;
}

export async function createPaypalConfig(orgId: number, data: PaypalConfigInput, access_token: string) {
  const body = { provider: 'paypal', enabled: true, ...data };
  const result = await secureFetch(
    `${getAPIUrl()}payments/${encodeURIComponent(String(orgId))}/config?provider=paypal`,
    RequestBodyWithAuthHeader('POST', body, null, access_token)
  );
  return getResponseMetadata(result);
}

export async function updatePaypalConfig(
  orgId: number,
  configId: number | string,
  data: Partial<PaypalConfigInput>,
  access_token: string
) {
  // Never send an empty secret: the backend would read it as "clear it".
  const body: Record<string, any> = { provider: 'paypal', ...data };
  if (!body.client_secret) delete body.client_secret;
  const result = await secureFetch(
    `${getAPIUrl()}payments/${encodeURIComponent(String(orgId))}/config/${encodeURIComponent(String(configId))}`,
    RequestBodyWithAuthHeader('PUT', body, null, access_token)
  );
  return getResponseMetadata(result);
}
