'use client'
// Sanar y Criar: blog editor for an existing article. A non-numeric id falls
// back to the list.
import React, { use } from 'react'
import { redirect } from 'next/navigation'
import BlogEditorPage from '@components/Dashboard/Pages/Blog/BlogEditorPage'

export default function EditBlogPostPage(props: { params: Promise<{ orgslug: string; postId: string }> }) {
  const params = use(props.params)
  const postId = /^\d{1,9}$/.test(params.postId) ? Number(params.postId) : 0
  // Browser-relative path only (the proxy adds the /orgs/{slug} prefix).
  if (!postId) redirect('/dash/blog')
  // The key starts a fresh editor (form state, AI job) for every article.
  return <BlogEditorPage key={postId} orgslug={params.orgslug} postId={postId} />
}
