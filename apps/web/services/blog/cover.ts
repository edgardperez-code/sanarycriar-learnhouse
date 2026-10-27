// Sanar y Criar: cover upload for a blog post. Runs in the browser (not a
// server action): a 5 MB image is over the 1 MB body limit of server actions.
import { getAPIUrl } from '@services/config/config'
import { RequestBodyFormWithAuthHeader, getResponseMetadata, secureFetch } from '@services/utils/ts/requests'

export async function uploadBlogCover(
  orgId: number,
  postId: number,
  file: File,
  access_token: string
): Promise<{ success: boolean; data: any; status: number }> {
  const url = `${getAPIUrl()}blog/${encodeURIComponent(String(orgId))}/posts/${encodeURIComponent(String(postId))}/cover`
  const formData = new FormData()
  formData.append('file', file)
  const result = await secureFetch(url, RequestBodyFormWithAuthHeader('PUT', formData, null, access_token))
  const { success, data, status } = await getResponseMetadata(result)
  return { success, data, status }
}
