'use client'
// Sanar y Criar: renders a blog post's HTML (made and sanitised by the API
// from the Markdown) inside the editor. It is sanitised again here with
// DOMPurify before it touches the DOM, and links open in a new tab so a click
// never leaves the editor. The panel has no @tailwindcss/typography, so the
// article styles are arbitrary variants on the container.
import React, { useMemo } from 'react'
import DOMPurify from 'dompurify'
import { getScSiteUrl } from '@components/Objects/Menus/scBrand'

const SANITIZE_CONFIG = {
  USE_PROFILES: { html: true },
  FORBID_TAGS: ['img', 'style', 'script', 'iframe', 'form', 'input', 'svg', 'math'],
  FORBID_ATTR: ['srcset'],
}

// A private instance: the link hook below must not affect the other DOMPurify
// users of the app (embeds, org scripts).
let purifier: ReturnType<typeof DOMPurify> | null = null

function getPurifier(): ReturnType<typeof DOMPurify> | null {
  if (typeof window === 'undefined') return null
  if (!purifier) {
    const instance = DOMPurify(window)
    if (!instance.isSupported) return null
    instance.addHook('afterSanitizeAttributes', (node) => {
      if (node.nodeName !== 'A') return
      const el = node as Element
      const href = el.getAttribute('href') || ''
      if (href.startsWith('#')) return
      // Internal links of the article (/agenda, /cursos…) point to the
      // marketing site, not to the panel.
      if (href.startsWith('/') && !href.startsWith('//')) el.setAttribute('href', getScSiteUrl(href))
      el.setAttribute('target', '_blank')
      el.setAttribute('rel', 'noopener noreferrer')
    })
    purifier = instance
  }
  return purifier
}

/** Sanitised HTML, or '' outside the browser (nothing is rendered on the server). */
export function sanitizeBlogHtml(html: string): string {
  const instance = getPurifier()
  if (!instance || !html) return ''
  return String(instance.sanitize(html, SANITIZE_CONFIG))
}

export const BLOG_PROSE_CLASS = [
  'text-[15px] leading-relaxed text-[#2A2440] break-words',
  '[&>*:first-child]:mt-0',
  '[&_h2]:mt-8 [&_h2]:mb-3 [&_h2]:text-xl [&_h2]:font-bold [&_h2]:tracking-tight [&_h2]:text-[#190933]',
  '[&_h3]:mt-6 [&_h3]:mb-2 [&_h3]:text-lg [&_h3]:font-semibold [&_h3]:text-[#190933]',
  '[&_h4]:mt-5 [&_h4]:mb-2 [&_h4]:font-semibold [&_h4]:text-[#190933]',
  '[&_p]:my-3',
  '[&_ul]:my-3 [&_ul]:list-disc [&_ul]:ps-6 [&_ol]:my-3 [&_ol]:list-decimal [&_ol]:ps-6 [&_li]:my-1',
  '[&_a]:text-[#6559CA] [&_a]:underline [&_a]:underline-offset-2 hover:[&_a]:text-[#41375B]',
  '[&_strong]:font-semibold [&_strong]:text-[#190933] [&_em]:italic [&_del]:line-through [&_s]:line-through',
  '[&_blockquote]:my-4 [&_blockquote]:border-s-4 [&_blockquote]:border-[#BBBBFF] [&_blockquote]:bg-[#EEEDFF]/50 [&_blockquote]:py-2 [&_blockquote]:ps-4 [&_blockquote]:pe-3 [&_blockquote]:text-[#41375B]',
  '[&_code]:rounded [&_code]:bg-gray-100 [&_code]:px-1 [&_code]:py-0.5 [&_code]:text-[0.9em]',
  '[&_pre]:my-4 [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:bg-gray-100 [&_pre]:p-3 [&_pre_code]:bg-transparent [&_pre_code]:p-0',
  '[&_hr]:my-6 [&_hr]:border-[#EAE8F2]',
  '[&_.table-wrap]:my-4 [&_.table-wrap]:overflow-x-auto',
  '[&_table]:w-full [&_table]:border-collapse [&_table]:text-sm',
  '[&_th]:border [&_th]:border-[#EAE8F2] [&_th]:bg-[#EEEDFF] [&_th]:px-3 [&_th]:py-2 [&_th]:text-start [&_th]:align-top [&_th]:font-semibold [&_th]:text-[#190933]',
  '[&_td]:border [&_td]:border-[#EAE8F2] [&_td]:px-3 [&_td]:py-2 [&_td]:align-top',
].join(' ')

export default function BlogPreview({ html, className = '' }: { html: string; className?: string }) {
  const clean = useMemo(() => sanitizeBlogHtml(html), [html])
  return <div className={`${BLOG_PROSE_CLASS} ${className}`} dangerouslySetInnerHTML={{ __html: clean }} />
}
