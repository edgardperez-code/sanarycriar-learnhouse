'use server';
// Sanar y Criar: blog admin endpoints (/api/v1/blog/{org_id}/…). The public
// listing and detail are read by the marketing site, not here. The cover
// upload runs in the browser (services/blog/cover.ts): 5 MB is over the 1 MB
// body limit of server actions.
import { getAPIUrl } from '@services/config/config';
import { RequestBodyWithAuthHeader, getResponseMetadata, secureFetch } from '@services/utils/ts/requests';
import type { BlogPostDraft, GenerateBody } from '@components/Dashboard/Pages/Blog/blogForm';

function blogUrl(orgId: number, path: string) {
  return `${getAPIUrl()}blog/${encodeURIComponent(String(orgId))}/${path}`;
}

function postPath(postId: number, suffix = '') {
  return `posts/${encodeURIComponent(String(postId))}${suffix}`;
}

async function call(orgId: number, path: string, method: string, body: any, access_token: string) {
  const result = await secureFetch(blogUrl(orgId, path), RequestBodyWithAuthHeader(method, body, null, access_token));
  return getResponseMetadata(result);
}

export async function getBlogConfig(orgId: number, access_token: string) {
  return call(orgId, 'config', 'GET', null, access_token);
}

export async function getBlogPosts(
  orgId: number,
  params: { page: number; limit: number; q: string; status: string },
  access_token: string
) {
  const query = new URLSearchParams({ page: String(params.page), limit: String(params.limit) });
  const q = (params.q || '').trim().slice(0, 100);
  if (q) query.set('q', q);
  if (params.status === 'draft' || params.status === 'published') query.set('status', params.status);
  return call(orgId, `posts?${query.toString()}`, 'GET', null, access_token);
}

export async function getBlogPost(orgId: number, postId: number, access_token: string) {
  return call(orgId, postPath(postId), 'GET', null, access_token);
}

export async function createBlogPost(orgId: number, body: BlogPostDraft, access_token: string) {
  return call(orgId, 'posts', 'POST', body, access_token);
}

export async function updateBlogPost(orgId: number, postId: number, body: BlogPostDraft, access_token: string) {
  return call(orgId, postPath(postId), 'PUT', body, access_token);
}

export async function deleteBlogPost(orgId: number, postId: number, access_token: string) {
  return call(orgId, postPath(postId), 'DELETE', null, access_token);
}

export async function publishBlogPost(orgId: number, postId: number, access_token: string) {
  return call(orgId, postPath(postId, '/publish'), 'POST', null, access_token);
}

export async function unpublishBlogPost(orgId: number, postId: number, access_token: string) {
  return call(orgId, postPath(postId, '/unpublish'), 'POST', null, access_token);
}

export async function deleteBlogCover(orgId: number, postId: number, access_token: string) {
  return call(orgId, postPath(postId, '/cover'), 'DELETE', null, access_token);
}

export async function previewBlogMarkdown(orgId: number, contentMd: string, access_token: string) {
  return call(orgId, 'preview', 'POST', { content_md: contentMd }, access_token);
}

export async function generateBlogPost(orgId: number, body: GenerateBody, access_token: string) {
  return call(orgId, 'ai/generate', 'POST', body, access_token);
}

export async function reviseBlogPost(orgId: number, postId: number, instruction: string, access_token: string) {
  return call(orgId, postPath(postId, '/ai/revise'), 'POST', { instruction }, access_token);
}

export async function getBlogJob(orgId: number, jobId: number, access_token: string) {
  return call(orgId, `ai/jobs/${encodeURIComponent(String(jobId))}`, 'GET', null, access_token);
}

export async function getActiveBlogJob(orgId: number, access_token: string) {
  return call(orgId, 'ai/jobs/active', 'GET', null, access_token);
}
