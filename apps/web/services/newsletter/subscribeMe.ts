// Sanar y Criar: the signed-in reader joins the newsletter from /regalo
// (POST /newsletter/{org_id}/subscribe/me). The API takes the email and the
// name from the session and refuses an unverified account; the body only
// says where it happened. Runs in the browser (not a server action, like
// export.ts), so the request is the reader's own.
import { getAPIUrl } from '@services/config/config'
import { RequestBodyWithAuthHeader, getResponseMetadata, secureFetch } from '@services/utils/ts/requests'

export async function subscribeMeToNewsletter(
  orgId: number,
  body: { source: string; page: string },
  access_token: string
) {
  const result = await secureFetch(
    `${getAPIUrl()}newsletter/${encodeURIComponent(String(orgId))}/subscribe/me`,
    RequestBodyWithAuthHeader('POST', body, null, access_token)
  )
  return getResponseMetadata(result)
}
