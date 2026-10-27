'use client'
// Sanar y Criar: blog section of the dashboard (articles of the marketing
// site). No FeatureGate: the section is always available and the API enforces
// the org-admin permission.
import React, { use } from 'react'
import BlogListPage from '@components/Dashboard/Pages/Blog/BlogListPage'

export default function BlogPage(props: { params: Promise<{ orgslug: string }> }) {
  const params = use(props.params)
  return <BlogListPage orgslug={params.orgslug} />
}
