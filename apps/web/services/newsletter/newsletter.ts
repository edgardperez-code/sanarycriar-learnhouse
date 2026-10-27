'use server';
// Sanar y Criar: newsletter admin endpoints (/api/v1/newsletter/{org_id}/…).
// The public config and the sign-up are called by the marketing site, not here.
import { getAPIUrl } from '@services/config/config';
import { RequestBodyWithAuthHeader, getResponseMetadata, secureFetch } from '@services/utils/ts/requests';
import type { NewsletterSettingsDraft } from '@components/Dashboard/Pages/Newsletter/newsletterForm';

function newsletterUrl(orgId: number, path: string) {
  return `${getAPIUrl()}newsletter/${encodeURIComponent(String(orgId))}/${path}`;
}

export async function getNewsletterSettings(orgId: number, access_token: string) {
  const result = await secureFetch(
    newsletterUrl(orgId, 'settings'),
    RequestBodyWithAuthHeader('GET', null, null, access_token)
  );
  return getResponseMetadata(result);
}

export async function updateNewsletterSettings(orgId: number, data: NewsletterSettingsDraft, access_token: string) {
  const result = await secureFetch(
    newsletterUrl(orgId, 'settings'),
    RequestBodyWithAuthHeader('PUT', data, null, access_token)
  );
  return getResponseMetadata(result);
}

export async function getNewsletterSubscribers(
  orgId: number,
  params: { page: number; limit: number; q: string },
  access_token: string
) {
  const query = new URLSearchParams({ page: String(params.page), limit: String(params.limit) });
  const q = (params.q || '').trim();
  if (q) query.set('q', q);
  const result = await secureFetch(
    newsletterUrl(orgId, `subscribers?${query.toString()}`),
    RequestBodyWithAuthHeader('GET', null, null, access_token)
  );
  return getResponseMetadata(result);
}

export async function deleteNewsletterSubscriber(orgId: number, subscriberId: number, access_token: string) {
  const result = await secureFetch(
    newsletterUrl(orgId, `subscribers/${encodeURIComponent(String(subscriberId))}`),
    RequestBodyWithAuthHeader('DELETE', null, null, access_token)
  );
  return getResponseMetadata(result);
}

export async function syncNewsletterSubscribers(orgId: number, access_token: string) {
  const result = await secureFetch(
    newsletterUrl(orgId, 'subscribers/sync'),
    RequestBodyWithAuthHeader('POST', null, null, access_token)
  );
  return getResponseMetadata(result);
}
