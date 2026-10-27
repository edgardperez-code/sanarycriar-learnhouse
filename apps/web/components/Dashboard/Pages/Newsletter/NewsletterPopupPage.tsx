'use client'
// Sanar y Criar: "Ventana emergente" tab of the newsletter section. Edits the
// sign-up pop-up shown on the marketing site (www): on/off, texts, delay and
// how long a "no" lasts, with a live mock next to the form.
import React, { useMemo, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import { Info, Loader2, Monitor, RotateCcw, Save, Smartphone } from 'lucide-react'
import { useOrg } from '@components/Contexts/OrgContext'
import { useLHSession } from '@components/Contexts/LHSessionContext'
import { Switch } from '@components/ui/switch'
import { Input } from '@components/ui/input'
import { Textarea } from '@components/ui/textarea'
import { Label } from '@components/ui/label'
import { Button } from '@components/ui/button'
import { queryKeys } from '@/lib/query/keys'
import { updateNewsletterSettings } from '@services/newsletter/newsletter'
import {
  NEWSLETTER_LIMITS,
  NewsletterAdminSettings,
  NewsletterFieldError,
  NewsletterSettingsDraft,
  NewsletterTextField,
  draftFromSettings,
  isSettingsDirty,
  settingsPayload,
  textLength,
  validateNewsletterSettings,
} from './newsletterForm'
import { NewsletterTranslate, useNewsletterT } from './useNewsletterT'
import { apiDetail, isForbidden, useNewsletterSettings } from './useNewsletterSettings'
import NewsletterPopupPreview from './NewsletterPopupPreview'

const TEXT_KEYS: NewsletterTextField[] = [
  'title',
  'body',
  'button_label',
  'dismiss_label',
  'success_message',
  'privacy_note',
]

function errorMessage(error: NewsletterFieldError | undefined, nl: NewsletterTranslate): string | null {
  if (!error) return null
  if (error.code === 'required') return nl('popup.error_required')
  if (error.code === 'too_long') {
    const max = NEWSLETTER_LIMITS[error.field as NewsletterTextField]
    return nl('popup.error_too_long', { max })
  }
  const range = NEWSLETTER_LIMITS[error.field as 'delay_seconds' | 'dismiss_days']
  return nl('popup.error_range', { min: range.min, max: range.max })
}

function Section({ title, className = '', children }: { title?: string; className?: string; children: React.ReactNode }) {
  return (
    <section className={`rounded-xl bg-white nice-shadow px-5 py-5 space-y-4 ${className}`}>
      {title && <h2 className="font-semibold text-[#190933]">{title}</h2>}
      {children}
    </section>
  )
}

type TextFieldProps = {
  field: NewsletterTextField
  label: string
  hint?: string
  multiline?: boolean
  rows?: number
  value: string
  error: string | null
  onChange: (_value: string) => void
  nl: NewsletterTranslate
}

function TextField({ field, label, hint, multiline, rows = 3, value, error, onChange, nl }: TextFieldProps) {
  const id = `nl-${field}`
  const max = NEWSLETTER_LIMITS[field]
  const length = textLength(value.trim())
  const describedBy = [hint ? `${id}-hint` : null, error ? `${id}-error` : null, `${id}-count`].filter(Boolean).join(' ')
  const common = {
    id,
    value,
    'aria-invalid': error ? true : undefined,
    'aria-describedby': describedBy,
    className: error ? 'border-red-400 focus-visible:ring-red-400' : undefined,
  }
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-3">
        <Label htmlFor={id} className="text-[#190933]">
          {label}
        </Label>
        <span
          id={`${id}-count`}
          className={`text-xs tabular-nums ${length > max ? 'text-red-600 font-semibold' : 'text-gray-400'}`}
        >
          {nl('char_count', { count: length, max })}
        </span>
      </div>
      {multiline ? (
        <Textarea {...common} rows={rows} onChange={(e) => onChange(e.target.value)} />
      ) : (
        <Input {...common} type="text" onChange={(e) => onChange(e.target.value)} />
      )}
      {hint && (
        <p id={`${id}-hint`} className="text-xs text-gray-500">
          {hint}
        </p>
      )}
      {error && (
        <p id={`${id}-error`} className="text-xs font-medium text-red-600">
          {error}
        </p>
      )}
    </div>
  )
}

type NumberFieldProps = {
  field: 'delay_seconds' | 'dismiss_days'
  label: string
  hint: string
  value: number
  error: string | null
  onChange: (_value: number) => void
}

function NumberField({ field, label, hint, value, error, onChange }: NumberFieldProps) {
  const id = `nl-${field}`
  const { min, max } = NEWSLETTER_LIMITS[field]
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id} className="text-[#190933]">
        {label}
      </Label>
      <Input
        id={id}
        type="number"
        inputMode="numeric"
        min={min}
        max={max}
        step={1}
        value={Number.isFinite(value) ? value : ''}
        aria-invalid={error ? true : undefined}
        aria-describedby={[`${id}-hint`, error ? `${id}-error` : null].filter(Boolean).join(' ')}
        className={`max-w-[10rem] ${error ? 'border-red-400 focus-visible:ring-red-400' : ''}`}
        onChange={(e) => onChange(e.target.value === '' ? Number.NaN : Number(e.target.value))}
      />
      <p id={`${id}-hint`} className="text-xs text-gray-500">
        {hint}
      </p>
      {error && (
        <p id={`${id}-error`} className="text-xs font-medium text-red-600">
          {error}
        </p>
      )}
    </div>
  )
}

function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T
  options: { value: T; label: string; icon?: React.ReactNode }[]
  onChange: (_value: T) => void
}) {
  return (
    <div className="inline-flex rounded-full border border-[#EAE8F2] bg-[#FFFCF9] p-0.5">
      {options.map((option) => {
        const active = option.value === value
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(option.value)}
            className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium transition-colors ${
              active ? 'bg-[#190933] text-white' : 'text-[#584F72] hover:bg-[#EEEDFF]'
            }`}
          >
            {option.icon}
            {option.label}
          </button>
        )
      })}
    </div>
  )
}

function LoadingSkeleton() {
  return (
    <div className="ms-4 me-4 sm:ms-10 sm:me-10 grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] animate-pulse">
      <div className="space-y-4">
        <div className="h-24 rounded-xl bg-white nice-shadow" />
        <div className="h-96 rounded-xl bg-white nice-shadow" />
      </div>
      <div className="h-80 rounded-xl bg-white nice-shadow" />
    </div>
  )
}

export default function NewsletterPopupPage() {
  const org = useOrg() as any
  const session = useLHSession() as any
  const accessToken: string | undefined = session?.data?.tokens?.access_token
  const queryClient = useQueryClient()
  const { nl } = useNewsletterT()
  const { data: settings, isLoading, error } = useNewsletterSettings()

  // Local edits on top of the saved settings; null = nothing edited.
  const [edits, setEdits] = useState<NewsletterSettingsDraft | null>(null)
  const [saving, setSaving] = useState(false)
  const [device, setDevice] = useState<'desktop' | 'mobile'>('desktop')
  const [view, setView] = useState<'form' | 'success'>('form')

  const saved = useMemo(() => (settings ? draftFromSettings(settings) : null), [settings])
  const draft = edits ?? saved
  const errors = useMemo(() => (draft ? validateNewsletterSettings(draft) : []), [draft])
  const dirty = !!(draft && saved && isSettingsDirty(draft, saved))

  if (error) {
    return (
      <div className="ms-4 me-4 sm:ms-10 sm:me-10 rounded-xl bg-white nice-shadow px-5 py-6 text-sm text-red-600">
        {isForbidden(error) ? nl('forbidden') : nl('load_error')}
      </div>
    )
  }
  if (isLoading || !draft || !settings) return <LoadingSkeleton />

  const errorFor = (field: keyof NewsletterSettingsDraft) =>
    errorMessage(
      errors.find((e) => e.field === field),
      nl
    )

  const update = <K extends keyof NewsletterSettingsDraft>(field: K, value: NewsletterSettingsDraft[K]) => {
    setEdits({ ...draft, [field]: value })
  }

  const restoreDefaults = () => {
    // Only the texts: the on/off switch and the timing stay as they are.
    const next = { ...draft }
    for (const key of TEXT_KEYS) next[key] = settings.defaults[key]
    setEdits(next)
    toast.success(nl('popup.restored'))
  }

  const save = async () => {
    if (saving || !dirty || errors.length > 0 || !accessToken) return
    setSaving(true)
    try {
      const res = await updateNewsletterSettings(org.id, settingsPayload(draft), accessToken)
      if (!res.success) {
        toast.error(apiDetail(res.data) ?? nl('popup.save_error'))
        return
      }
      queryClient.setQueryData<NewsletterAdminSettings>(queryKeys.newsletter.settings(org.id), res.data)
      setEdits(null)
      toast.success(nl('popup.saved'))
    } catch {
      toast.error(nl('popup.save_error'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="ms-4 me-4 sm:ms-10 sm:me-10 pb-10 grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] items-start">
      {/* Form */}
      <div className="space-y-4 min-w-0">
        <Section>
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-1 min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <Label htmlFor="nl-enabled" className="text-[#190933] font-semibold">
                  {nl('popup.enabled_label')}
                </Label>
                <span
                  className={`text-xs px-2 py-0.5 rounded-full ${
                    draft.enabled ? 'text-green-700 bg-green-100' : 'text-gray-600 bg-gray-100'
                  }`}
                >
                  {draft.enabled ? nl('popup.status_on') : nl('popup.status_off')}
                </span>
              </div>
              <p id="nl-enabled-hint" className="text-sm text-gray-500">
                {nl('popup.enabled_hint')}
              </p>
            </div>
            <Switch
              id="nl-enabled"
              checked={draft.enabled}
              onCheckedChange={(checked) => update('enabled', checked === true)}
              aria-describedby="nl-enabled-hint"
              className="mt-0.5"
            />
          </div>
        </Section>

        <Section title={nl('popup.texts_title')}>
          <TextField
            field="title"
            label={nl('popup.title_label')}
            value={draft.title}
            error={errorFor('title')}
            onChange={(v) => update('title', v)}
            nl={nl}
          />
          <TextField
            field="body"
            label={nl('popup.body_label')}
            multiline
            rows={4}
            value={draft.body}
            error={errorFor('body')}
            onChange={(v) => update('body', v)}
            nl={nl}
          />
          <div className="grid gap-4 sm:grid-cols-2">
            <TextField
              field="button_label"
              label={nl('popup.button_text')}
              value={draft.button_label}
              error={errorFor('button_label')}
              onChange={(v) => update('button_label', v)}
              nl={nl}
            />
            <TextField
              field="dismiss_label"
              label={nl('popup.dismiss_text')}
              value={draft.dismiss_label}
              error={errorFor('dismiss_label')}
              onChange={(v) => update('dismiss_label', v)}
              nl={nl}
            />
          </div>
          <TextField
            field="success_message"
            label={nl('popup.success_label')}
            hint={nl('popup.success_hint')}
            multiline
            rows={2}
            value={draft.success_message}
            error={errorFor('success_message')}
            onChange={(v) => update('success_message', v)}
            nl={nl}
          />
          <TextField
            field="privacy_note"
            label={nl('popup.privacy_label')}
            hint={nl('popup.privacy_hint')}
            multiline
            rows={2}
            value={draft.privacy_note}
            error={errorFor('privacy_note')}
            onChange={(v) => update('privacy_note', v)}
            nl={nl}
          />
        </Section>

        <Section title={nl('popup.timing_title')}>
          <div className="grid gap-4 sm:grid-cols-2">
            <NumberField
              field="delay_seconds"
              label={nl('popup.delay_label')}
              hint={nl('popup.delay_hint')}
              value={draft.delay_seconds}
              error={errorFor('delay_seconds')}
              onChange={(v) => update('delay_seconds', v)}
            />
            <NumberField
              field="dismiss_days"
              label={nl('popup.days_label')}
              hint={nl('popup.days_hint')}
              value={draft.dismiss_days}
              error={errorFor('dismiss_days')}
              onChange={(v) => update('dismiss_days', v)}
            />
          </div>
          <p className="flex items-start gap-2 rounded-lg bg-[#EEEDFF]/60 px-3 py-2 text-xs text-[#41375B]">
            <Info size={14} className="mt-0.5 shrink-0 text-[#6559CA]" aria-hidden />
            <span>{nl('popup.test_hint')}</span>
          </p>
        </Section>

        <p
          className={`flex items-start gap-2 rounded-xl border px-4 py-3 text-sm ${
            settings.resend_enabled
              ? 'border-[#BBBBFF] bg-[#EEEDFF]/50 text-[#41375B]'
              : 'border-amber-200 bg-amber-50 text-amber-800'
          }`}
        >
          <Info size={16} className="mt-0.5 shrink-0" aria-hidden />
          <span>{settings.resend_enabled ? nl('resend.on') : nl('resend.off')}</span>
        </p>

        {/* Actions: pinned to the bottom of the scroll area on desktop. */}
        <div className="lg:sticky lg:bottom-4 z-10 flex flex-wrap items-center justify-between gap-3 rounded-xl bg-white nice-shadow px-5 py-3">
          <p role="status" className="text-sm text-amber-700 min-h-5">
            {dirty ? nl('popup.unsaved') : ''}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" variant="outline" size="sm" onClick={restoreDefaults} disabled={saving}>
              <RotateCcw aria-hidden />
              {nl('popup.restore_defaults')}
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={save}
              disabled={saving || !dirty || errors.length > 0}
              aria-busy={saving || undefined}
              className="bg-[#190933] text-white hover:bg-[#41375B]"
            >
              {saving ? <Loader2 className="animate-spin" aria-hidden /> : <Save aria-hidden />}
              {saving ? nl('popup.saving') : nl('popup.save')}
            </Button>
          </div>
        </div>
      </div>

      {/* Preview. Sticky next to the form; if it is taller than the visible
          area (phone mock on a short screen) it scrolls on its own instead of
          hiding its bottom. */}
      <div className="lg:sticky lg:top-6 min-w-0">
        <Section className="lg:max-h-[calc(100vh-19rem)] lg:overflow-y-auto">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="font-semibold text-[#190933]">{nl('preview.title')}</h2>
            <div className="flex flex-wrap items-center gap-2">
              <Segmented
                value={device}
                onChange={setDevice}
                options={[
                  { value: 'desktop', label: nl('preview.desktop'), icon: <Monitor size={13} aria-hidden /> },
                  { value: 'mobile', label: nl('preview.mobile'), icon: <Smartphone size={13} aria-hidden /> },
                ]}
              />
              <Segmented
                value={view}
                onChange={setView}
                options={[
                  { value: 'form', label: nl('preview.show_form') },
                  { value: 'success', label: nl('preview.show_success') },
                ]}
              />
            </div>
          </div>
          <NewsletterPopupPreview draft={draft} device={device} view={view} />
        </Section>
      </div>
    </div>
  )
}
