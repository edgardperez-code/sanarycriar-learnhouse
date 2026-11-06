'use client'
// Sanar y Criar: "Ajustes de los pagos manuales", the first card of "Pagos
// manuales" in Pagos › Configuración: what every manual method shares (manual
// methods contract §A.1). The WhatsApp for the receipts (every method needs
// it), the time to pay, the exchange rate (BCV or manual; used by Pago Móvil
// and the bank transfer) and the e-mail for new-order notices, with today's
// rate and a way to Pedidos at the bottom. No switch: Edit / Save / Cancel.
//
// It saves through PUT /manual/settings sending only these fields. Clearing
// one that a method that is on needs answers INCOMPLETE: with `method` (bank
// transfer, Zelle, Binance) the API's message says which one to switch off
// first; without it, it is Pago Móvil's own check. The error goes under the
// field and in the banner.
//
// The manual rate is read with the same rule as the API (parseManualRate): a
// live line says how it will be saved, and an ambiguous text ("1.050") or a
// rate more than 50 % away from today's BCV rate stops the save.
import React, { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useQueryClient } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import { AlertTriangle, Info, SlidersHorizontal } from 'lucide-react'
import { Input } from '@components/ui/input'
import { useOrg } from '@components/Contexts/OrgContext'
import { useScT } from '@components/Payments/useScT'
import { describePaymentError, errorCode, errorField } from '@components/Payments/commerce'
import { getUriWithOrg } from '@services/config/config'
import { updateManualSettings } from '@services/payments/orders'
import { queryKeys } from '@/lib/query/keys'
import {
  COMMON_FIELDS,
  ManualDraft,
  ManualField,
  ManualFieldError,
  ManualSettings,
  ManualSettingsBody,
  ORDER_LIMITS,
  commonSettingsIncomplete,
  commonSettingsPayload,
  draftFromManualSettings,
  errorList,
  formatIsoDate,
  formatRate,
  formatRatePreview,
  isCommonDraftDirty,
  parseManualRate,
  parseWindowHours,
  rateFarFromBcv,
  validateCommonDraft,
  whatsappInfo,
} from '../Orders/ordersForm'
import { useManualSettings, useOrdersAuth } from '../Orders/useOrdersApi'
import { OrdersTranslate, useOrdersT } from '../Orders/useOrdersT'
import {
  CardFormError,
  CardHeader,
  CardLoadError,
  CardSkeleton,
  EditButton,
  Field,
  FormFooter,
  SavedRow,
  SavedSummary,
  fieldAria,
  useRefreshManual,
} from './ManualCardParts'

type CommonField = (typeof COMMON_FIELDS)[number]

const isCommonField = (field: string): field is CommonField => (COMMON_FIELDS as readonly string[]).includes(field)

/** Today's BCV rate, when the API reports one (in manual mode it reports the manual rate). */
function bcvRateOf(data: ManualSettings | undefined): number | null {
  const fx = data?.fx
  return fx && fx.source === 'bcv' && typeof fx.rate === 'number' && fx.rate > 0 ? fx.rate : null
}

function clientErrorText(error: ManualFieldError, ot: OrdersTranslate, bcvRate: number | null): string {
  switch (error.code) {
    case 'window':
      return ot('manual_settings.window_error')
    case 'rate_ambiguous':
      return ot('manual_settings.rate_ambiguous')
    case 'rate_far':
      return ot('manual_settings.rate_far', { bcv: formatRate(bcvRate) })
    case 'whatsapp':
      return ot('manual_settings.whatsapp_error')
    case 'whatsapp_country':
      return ot('manual_settings.whatsapp_country')
    default:
      return ot('manual_settings.rate_error')
  }
}

export default function ManualSettingsCard() {
  const { ot } = useOrdersT()
  const { sc } = useScT()
  const org = useOrg() as any
  const queryClient = useQueryClient()
  const refresh = useRefreshManual()
  const { orgId, accessToken } = useOrdersAuth()
  const { data, isLoading, error } = useManualSettings()

  const [editOpen, setEditOpen] = useState<boolean | null>(null)
  const [edits, setEdits] = useState<ManualDraft | null>(null)
  const [attempted, setAttempted] = useState(false)
  const [apiErrors, setApiErrors] = useState<Partial<Record<ManualField, string>>>({})
  const [formError, setFormError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  // Bumped after a failed save: the first field with an error gets the focus.
  const [focusTick, setFocusTick] = useState(0)
  const formRef = useRef<HTMLFormElement>(null)

  const saved = useMemo(() => (data ? draftFromManualSettings(data) : null), [data])
  const draft = edits ?? saved
  const bcvRate = bcvRateOf(data)
  const clientErrors = useMemo(() => (draft ? validateCommonDraft(draft, { bcvRate }) : []), [draft, bcvRate])
  const dirty = !!(draft && saved && isCommonDraftDirty(draft, saved))
  const ordersHref = getUriWithOrg(org?.slug, '/dash/orders')
  const icon = <SlidersHorizontal size={20} aria-hidden />

  useEffect(() => {
    if (!focusTick) return
    formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus()
  }, [focusTick])

  if (isLoading) return <CardSkeleton />
  if (error || !data || !draft || !saved) {
    return <CardLoadError icon={icon} title={ot('manual_settings.title')} message={ot('manual_settings.load_error')} />
  }

  // Open by default while something every method needs is missing.
  const incomplete = commonSettingsIncomplete(data.settings)
  const editing = editOpen ?? incomplete
  const noWhatsapp = !String(data.settings?.whatsapp ?? '').trim()

  const update = <K extends keyof ManualDraft>(field: K, value: ManualDraft[K]) => {
    setEdits({ ...draft, [field]: value })
    setApiErrors((prev) => {
      if (!(field in prev)) return prev
      const next = { ...prev }
      delete next[field as ManualField]
      return next
    })
  }

  const errorFor = (field: CommonField): string | null => {
    if (apiErrors[field]) return apiErrors[field] as string
    if (attempted) {
      const clientError = clientErrors.find((e) => e.field === field)
      if (clientError) return clientErrorText(clientError, ot, bcvRate)
    }
    return null
  }

  // fx_manual_rate is the only field that can be hidden while the form is open.
  const fieldVisible = (field: string) => field !== 'fx_manual_rate' || draft.fx_mode === 'manual'

  const resetForm = () => {
    setEdits(null)
    setAttempted(false)
    setApiErrors({})
    setFormError(null)
  }

  const put = async (body: ManualSettingsBody) => {
    if (saving || !accessToken) return
    setSaving(true)
    setFormError(null)
    setApiErrors({})
    try {
      const res = await updateManualSettings(orgId, body, accessToken)
      if (!res.success) {
        const code = errorCode(res.data)
        const message = describePaymentError(res.data, sc)
        if (code === 'INVALID_FIELD') {
          const field = errorField(res.data, 'field')
          if (field && isCommonField(field)) {
            setApiErrors({ [field]: message })
            // An error under a field she cannot see would go unnoticed.
            if (!fieldVisible(field)) setFormError(message)
            setFocusTick((tick) => tick + 1)
            return
          }
        }
        if (code === 'INCOMPLETE') {
          // A method that is on needs what she cleared: with `method`, the
          // API names it ("primero desactiva Zelle"); without it, Pago Móvil.
          const lacking = errorList(res.data, 'missing').filter(isCommonField)
          const text = errorField(res.data, 'method')
            ? message
            : lacking.includes('whatsapp')
              ? ot('manual_settings.needed_whatsapp')
              : lacking.includes('fx_manual_rate')
                ? ot('manual_settings.needed_rate')
                : message
          setApiErrors(Object.fromEntries(lacking.map((field) => [field, text])))
          setFormError(text)
          setFocusTick((tick) => tick + 1)
          return
        }
        setFormError(message)
        return
      }
      queryClient.setQueryData<ManualSettings>(queryKeys.orders.manualSettings(orgId), res.data)
      refresh(orgId)
      resetForm()
      // Closes once everything every method needs is there.
      setEditOpen(null)
      toast.success(ot('manual_settings.saved'))
    } catch {
      setFormError(ot('manual_settings.save_error'))
    } finally {
      setSaving(false)
    }
  }

  const save = (e?: React.FormEvent) => {
    e?.preventDefault()
    setAttempted(true)
    // Errors the form can see by itself stop the request (and say so).
    if (clientErrors.length > 0) {
      setFormError(ot('manual_card.fix_fields'))
      setFocusTick((tick) => tick + 1)
      return
    }
    put(commonSettingsPayload(draft))
  }

  // Live lines under the WhatsApp and the manual rate.
  const whatsapp = whatsappInfo(draft.whatsapp)
  const whatsappError = errorFor('whatsapp')
  const whatsappLine = whatsappError ? null : whatsapp.missingCountry ? (
    <p id="ms-whatsapp-extra" className="text-xs font-medium text-amber-700">
      {ot('manual_settings.whatsapp_country')}
    </p>
  ) : whatsapp.preview ? (
    <p id="ms-whatsapp-extra" className="text-xs text-[#584F72]">
      {ot('manual_settings.whatsapp_preview', { number: whatsapp.preview })}
    </p>
  ) : null

  const rate = parseManualRate(draft.fx_manual_rate)
  const rateError = errorFor('fx_manual_rate')
  const rateFar = rate.ok && rateFarFromBcv(rate.value, bcvRate)
  const rateLiveError = !rateError && (rateFar || (!rate.ok && rate.code === 'ambiguous'))
  const rateLine = rateError ? null : rateFar ? (
    <p id="ms-rate-extra" className="text-xs font-medium text-red-600">
      {ot('manual_settings.rate_far', { bcv: formatRate(bcvRate) })}
    </p>
  ) : rate.ok ? (
    <p id="ms-rate-extra" className="text-xs font-medium text-[#4F43A4]">
      {ot('manual_settings.rate_preview', { rate: formatRatePreview(rate.value) })}
    </p>
  ) : rate.code === 'ambiguous' ? (
    <p id="ms-rate-extra" className="text-xs font-medium text-red-600">
      {ot('manual_settings.rate_ambiguous')}
    </p>
  ) : null

  const windowHours = parseWindowHours(draft.payment_window_hours)

  return (
    <div className="border border-[#EAE8F2] rounded-xl overflow-hidden">
      <CardHeader
        icon={icon}
        title={ot('manual_settings.title')}
        tagline={ot('manual_settings.tagline')}
        notes={
          noWhatsapp ? (
            <p className="mt-1 flex items-start gap-1 text-xs font-medium text-amber-700">
              <AlertTriangle size={12} className="mt-px shrink-0" aria-hidden />
              <span>{ot('manual_settings.no_whatsapp')}</span>
            </p>
          ) : null
        }
        actions={
          !editing ? (
            <EditButton
              label={ot('manual_card.edit')}
              disabled={saving}
              onClick={() => {
                resetForm()
                setEditOpen(true)
              }}
            />
          ) : null
        }
      />

      <CardFormError message={formError} />

      {editing ? (
        <form ref={formRef} onSubmit={save} className="border-t border-[#EAE8F2] bg-[#FFFCF9] px-5 py-5" autoComplete="off" noValidate>
          {/* Everything is read-only while a request runs. */}
          <fieldset disabled={saving} aria-busy={saving ? true : undefined} className="m-0 min-w-0 space-y-6 border-0 p-0">
            <fieldset className="space-y-4">
              <legend className="mb-3 text-sm font-semibold text-[#190933]">{ot('manual_settings.section_receipts')}</legend>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <Field
                  id="ms-whatsapp"
                  label={ot('manual_settings.whatsapp_label')}
                  hint={ot('manual_settings.whatsapp_hint')}
                  error={whatsappError}
                  extra={whatsappLine}
                >
                  <Input
                    id="ms-whatsapp"
                    type="tel"
                    inputMode="tel"
                    value={draft.whatsapp}
                    onChange={(e) => update('whatsapp', e.target.value)}
                    className="font-mono"
                    {...fieldAria('ms-whatsapp', { hint: true, extra: !!whatsappLine, error: whatsappError })}
                  />
                </Field>
              </div>
            </fieldset>

            <fieldset className="space-y-4">
              <legend className="mb-3 text-sm font-semibold text-[#190933]">{ot('manual_settings.section_rules')}</legend>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <Field
                  id="ms-window"
                  label={ot('manual_settings.window_label')}
                  hint={ot('manual_settings.window_hint')}
                  error={errorFor('payment_window_hours')}
                >
                  <div className="flex items-center gap-2">
                    <Input
                      id="ms-window"
                      type="number"
                      inputMode="numeric"
                      min={ORDER_LIMITS.window_min}
                      max={ORDER_LIMITS.window_max}
                      step={1}
                      value={draft.payment_window_hours}
                      onChange={(e) => update('payment_window_hours', e.target.value)}
                      className="max-w-[7rem]"
                      {...fieldAria('ms-window', { hint: true, error: errorFor('payment_window_hours') })}
                    />
                    <span className="text-sm text-gray-500">{ot('manual_settings.window_unit', { count: windowHours ?? 2 })}</span>
                  </div>
                </Field>
                <div className="space-y-1.5">
                  <span id="ms-fx-label" className="block text-sm font-medium text-[#190933]">
                    {ot('manual_settings.fx_label')}
                  </span>
                  <div
                    role="group"
                    aria-labelledby="ms-fx-label"
                    aria-describedby="ms-fx-note"
                    className="inline-flex rounded-full border border-[#EAE8F2] bg-white p-0.5"
                  >
                    {(['auto', 'manual'] as const).map((mode) => {
                      const active = draft.fx_mode === mode
                      return (
                        <button
                          key={mode}
                          type="button"
                          aria-pressed={active}
                          onClick={() => update('fx_mode', mode)}
                          className={`min-h-11 rounded-full px-3 py-1 text-xs font-medium transition-colors sm:min-h-0 ${
                            active ? 'bg-[#190933] text-white' : 'text-[#584F72] hover:bg-[#EEEDFF]'
                          }`}
                        >
                          {mode === 'auto' ? ot('manual_settings.fx_auto') : ot('manual_settings.fx_manual')}
                        </button>
                      )
                    })}
                  </div>
                  <p id="ms-fx-note" className="text-xs text-gray-500">
                    {ot('manual_settings.fx_note')}
                  </p>
                  {draft.fx_mode === 'manual' && (
                    <div className="pt-2">
                      <Field
                        id="ms-rate"
                        label={ot('manual_settings.fx_manual_label')}
                        hint={ot('manual_settings.fx_manual_hint')}
                        error={rateError}
                        extra={rateLine}
                      >
                        <Input
                          id="ms-rate"
                          inputMode="decimal"
                          value={draft.fx_manual_rate}
                          onChange={(e) => update('fx_manual_rate', e.target.value)}
                          className="max-w-[10rem] font-mono"
                          {...fieldAria('ms-rate', { hint: true, extra: !!rateLine, error: rateError, invalid: rateLiveError })}
                        />
                      </Field>
                    </div>
                  )}
                </div>
              </div>
            </fieldset>

            <fieldset className="space-y-4">
              <legend className="mb-3 text-sm font-semibold text-[#190933]">{ot('manual_settings.section_notices')}</legend>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <Field
                  id="ms-notify"
                  label={ot('manual_settings.notify_label')}
                  hint={ot('manual_settings.notify_hint')}
                  error={errorFor('notify_email')}
                >
                  <Input
                    id="ms-notify"
                    type="email"
                    inputMode="email"
                    value={draft.notify_email}
                    onChange={(e) => update('notify_email', e.target.value)}
                    {...fieldAria('ms-notify', { hint: true, error: errorFor('notify_email') })}
                  />
                </Field>
              </div>
            </fieldset>

            <FormFooter
              ot={ot}
              dirty={dirty}
              canCancel={!incomplete}
              saving={saving}
              onCancel={() => {
                resetForm()
                setEditOpen(false)
              }}
            />
          </fieldset>
        </form>
      ) : (
        <CommonSummary data={data} ot={ot} />
      )}

      <FxAndHelp data={data} ot={ot} ordersHref={ordersHref} />
    </div>
  )
}

function CommonSummary({ data, ot }: { data: ManualSettings; ot: OrdersTranslate }) {
  const s = data.settings
  const whatsapp = whatsappInfo(s.whatsapp)
  const rows: SavedRow[] = [
    { label: ot('manual_settings.whatsapp_label'), value: whatsapp.preview || s.whatsapp || '—', mono: true },
    { label: ot('manual_settings.window_label'), value: ot('manual_settings.summary_window', { count: Number(s.payment_window_hours) || 0 }) },
    {
      label: ot('manual_settings.fx_label'),
      value:
        s.fx_mode === 'manual'
          ? ot('manual_settings.summary_fx_manual', { rate: formatRate(s.fx_manual_rate) })
          : ot('manual_settings.fx_auto'),
    },
    { label: ot('manual_settings.summary_notify'), value: s.notify_email || ot('manual_settings.summary_notify_none') },
  ]
  return <SavedSummary rows={rows} />
}

function FxAndHelp({ data, ot, ordersHref }: { data: ManualSettings; ot: OrdersTranslate; ordersHref: string }) {
  const fx = data.fx
  let today: string | null = null
  if (fx && fx.rate !== null && fx.rate !== undefined) {
    const rate = formatRate(fx.rate)
    today =
      fx.source === 'manual'
        ? ot('manual_settings.fx_today_manual', { rate })
        : fx.rate_date
          ? ot('manual_settings.fx_today_bcv', { rate, date: formatIsoDate(fx.rate_date) })
          : ot('manual_settings.fx_today_bcv_undated', { rate })
    if (fx.stale) today = `${today} ${ot('manual_settings.fx_stale')}`
  }
  return (
    <div className="border-t border-[#EAE8F2] bg-white px-5 py-3 space-y-2 text-sm">
      {today && <p className="font-medium text-[#190933]">{today}</p>}
      {fx?.warning && (
        <p className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
          <AlertTriangle size={13} className="mt-0.5 shrink-0" aria-hidden />
          <span>{fx.warning}</span>
        </p>
      )}
      {fx?.error && (
        <p className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
          <AlertTriangle size={13} className="mt-0.5 shrink-0" aria-hidden />
          <span>
            {fx.error}
            {/* With the manual rate already chosen, the way out is to type it, not to pick it. */}
            {fx.source !== 'manual' && <> {ot('manual_settings.fx_error_hint')}</>}
          </span>
        </p>
      )}
      <p className="flex items-start gap-2 text-xs text-[#584F72]">
        <Info size={13} className="mt-0.5 shrink-0 text-[#7D75E2]" aria-hidden />
        <span>
          {ot('manual_settings.help')}{' '}
          <Link href={ordersHref} className="font-medium text-[#4F43A4] underline underline-offset-2">
            {ot('manual_settings.go_to_orders')}
          </Link>
        </span>
      </p>
    </div>
  )
}
