'use client'
// Sanar y Criar: the post's cover. The image is uploaded (and removed) right
// away, on its own request; the alt text travels with the rest of the form.
// The API turns it into a WebP for the page and a 1200x630 JPEG for social
// previews, without EXIF data.
import React, { useRef, useState } from 'react'
import toast from 'react-hot-toast'
import { ImageOff, ImagePlus, Loader2, Trash2 } from 'lucide-react'
import { Button } from '@components/ui/button'
import { deleteBlogCover } from '@services/blog/blog'
import { uploadBlogCover } from '@services/blog/cover'
import { AdminPost, BLOG_LIMITS, COVER_ACCEPT, MAX_COVER_BYTES } from './blogForm'
import { TextField } from './BlogFields'
import { apiDetail, useBlogAuth } from './useBlogApi'
import { useBlogT } from './useBlogT'

type Props = {
  /** null while creating: a cover needs a saved post. */
  post: AdminPost | null
  alt: string
  onAltChange: (_value: string) => void
  altError?: string | null
  onPostChange: (_post: AdminPost) => void
  disabled?: boolean
}

export default function BlogCoverField({ post, alt, onAltChange, altError, onPostChange, disabled }: Props) {
  const { bt } = useBlogT()
  const { orgId, accessToken } = useBlogAuth()
  const fileRef = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState<'upload' | 'remove' | null>(null)

  if (!post) {
    return (
      <p className="flex items-start gap-2 rounded-lg border border-dashed border-[#EAE8F2] bg-[#FFFCF9] px-3 py-4 text-sm text-gray-500">
        <ImageOff size={16} className="mt-0.5 shrink-0 text-gray-400" aria-hidden />
        <span>{bt('editor.cover_save_first')}</span>
      </p>
    )
  }

  const onFile = async (file: File | undefined) => {
    if (fileRef.current) fileRef.current.value = ''
    if (!file || !accessToken || busy) return
    if (file.size > MAX_COVER_BYTES) {
      toast.error(bt('editor.cover_too_big'))
      return
    }
    setBusy('upload')
    try {
      const res = await uploadBlogCover(orgId, post.id, file, accessToken)
      if (!res.success) {
        toast.error(apiDetail(res.data) ?? bt('editor.cover_error'))
        return
      }
      onPostChange(res.data as AdminPost)
      toast.success(bt('editor.cover_uploaded'))
    } catch {
      toast.error(bt('editor.cover_error'))
    } finally {
      setBusy(null)
    }
  }

  const onRemove = async () => {
    if (!accessToken || busy) return
    setBusy('remove')
    try {
      const res = await deleteBlogCover(orgId, post.id, accessToken)
      if (!res.success) {
        toast.error(apiDetail(res.data) ?? bt('editor.cover_remove_error'))
        return
      }
      onPostChange(res.data as AdminPost)
      toast.success(bt('editor.cover_removed'))
    } catch {
      toast.error(bt('editor.cover_remove_error'))
    } finally {
      setBusy(null)
    }
  }

  const locked = disabled || busy !== null

  return (
    <div className="space-y-3">
      {post.cover_url ? (
        <div className="overflow-hidden rounded-lg border border-[#EAE8F2] bg-[#FFFCF9]">
          <img
            src={post.cover_url}
            alt={alt.trim() || bt('editor.cover_current_alt')}
            className="aspect-[16/9] w-full object-cover"
            loading="lazy"
          />
        </div>
      ) : (
        <button
          type="button"
          disabled={locked}
          onClick={() => fileRef.current?.click()}
          className="flex aspect-[16/9] w-full flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-[#BBBBFF] bg-[#FFFCF9] text-sm text-[#6559CA] transition-colors hover:bg-[#EEEDFF] disabled:cursor-not-allowed disabled:opacity-60"
        >
          {busy === 'upload' ? <Loader2 size={22} className="animate-spin" aria-hidden /> : <ImagePlus size={22} aria-hidden />}
          <span className="font-medium">{busy === 'upload' ? bt('editor.cover_uploading') : bt('editor.cover_upload')}</span>
        </button>
      )}

      <input
        ref={fileRef}
        type="file"
        accept={COVER_ACCEPT}
        className="sr-only"
        tabIndex={-1}
        aria-hidden
        onChange={(e) => onFile(e.target.files?.[0])}
      />

      {post.cover_url && (
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" size="sm" disabled={locked} onClick={() => fileRef.current?.click()} aria-busy={busy === 'upload' || undefined}>
            {busy === 'upload' ? <Loader2 className="animate-spin" aria-hidden /> : <ImagePlus aria-hidden />}
            {busy === 'upload' ? bt('editor.cover_uploading') : bt('editor.cover_replace')}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={locked}
            onClick={onRemove}
            aria-busy={busy === 'remove' || undefined}
            className="text-red-600 hover:bg-red-50 hover:text-red-700"
          >
            {busy === 'remove' ? <Loader2 className="animate-spin" aria-hidden /> : <Trash2 aria-hidden />}
            {bt('editor.cover_remove')}
          </Button>
        </div>
      )}
      <p className="text-xs text-gray-500">{bt('editor.cover_hint')}</p>

      <TextField
        id="blog-cover-alt"
        label={bt('editor.cover_alt_label')}
        hint={bt('editor.cover_alt_hint')}
        value={alt}
        onChange={onAltChange}
        max={BLOG_LIMITS.cover_alt}
        error={altError}
        disabled={disabled}
      />
    </div>
  )
}
