'use client'
// Sanar y Criar: blog editor, creating a new article.
import React, { use } from 'react'
import BlogEditorPage from '@components/Dashboard/Pages/Blog/BlogEditorPage'

export default function NewBlogPostPage(props: { params: Promise<{ orgslug: string }> }) {
  const params = use(props.params)
  return <BlogEditorPage orgslug={params.orgslug} postId={null} />
}
