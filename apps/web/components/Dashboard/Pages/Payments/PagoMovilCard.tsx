'use client'
// Sanar y Criar: "Pago Móvil" card of Pagos → Configuración (cart contract
// §C.5). The bank account that receives the payments, the WhatsApp for the
// receipts, the time to pay, the exchange rate (BCV or manual) and the e-mail
// for new-order notices. The switch saves right away: turning it on while the
// form has changes saves them too, and the API answers INCOMPLETE when a
// required field is missing. Formats are checked by the API, which names the
// wrong field (INVALID_FIELD); the error shows under it and the focus goes to
// the first field with an error.
//
// The manual rate is read with the same rule as the API (parseManualRate):
// a live line says how it will be saved, and an ambiguous text ("1.050") or a
// rate more than 50 % away from today's BCV rate stops the save.
import React, { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useQueryClient } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import { AlertTriangle, CheckCircle2, CircleOff, Info, Loader2, Pencil, Smartphone } from 'lucide-react'
import { Button } from '@components/ui/button'
import { Input } from '@components/ui/input'
import { Label } from '@components/ui/label'
import { Switch } from '@components/ui/switch'
import { Textarea } from '@components/ui/textarea'
import { useOrg } from '@components/Contexts/OrgContext'
import { useScT } from '@components/Payments/useScT'
import { describePaymentError, errorCode, errorField } from '@components/Payments/commerce'
import { getUriWithOrg } from '@services/config/config'
import { updateManualSettings } from '@services/payments/orders'
import { queryKeys } from '@/lib/query/keys'
import {
  MANUAL_FIELDS,
  ManualDraft,
  ManualField,
  ManualFieldError,
  ManualSettings,
  ManualSettingsBody,
  ORDER_LIMITS,
  OTHER_BANK,
  VE_BANKS,
  bankByCode,
  draftFromManualSettings,
  errorList,
  formatIsoDate,
  formatRate,
  formatRatePreview,
  isManualDraftDirty,
  manualSettingsPayload,
  parseManualRate,
  parseWindowHours,
  rateFarFromBcv,
  textLength,
  validateManualDraft,
  whatsappInfo,
} from '../Orders/ordersForm'
import { useManualSettings, useOrdersAuth } from '../Orders/useOrdersApi'
import { OrdersTranslate, ordersLabel, useOrdersT } from '../Orders/useOrdersT'

type Busy = 'save' | 'enable' | 'disable' | null

const SELECT_CLASS =
  'flex h-9 w-full rounded-lg border border-input bg-card px-3 py-1 text-sm shadow-xs focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50'

function fieldLabel(ot: OrdersTranslate, field: string): string {
  return (MANUAL_FIELDS as readonly string[]).includes(field) ? ordersLabel(ot, 'fields', field) : field
}

/** Today's BCV rate, when the API reports one (in manual mode it reports the manual rate). */
function bcvRateOf(data: ManualSettings | undefined): number | null {
  const fx = data?.fx
  return fx && fx.source === 'bcv' && typeof fx.rate === 'number' && fx.rate > 0 ? fx.rate : null
}

function clientErrorText(error: ManualFieldError, ot: OrdersTranslate, bcvRate: number | null): string {
  switch (error.code) {
    case 'bank_name':
      return ot('pago_movil.bank_name_error')
    case 'window':
      return ot('pago_movil.window_error')
    case 'rate':
      return ot('pago_movil.rate_error')
    case 'rate_ambiguous':
      return ot('pago_movil.rate_ambiguous')
    case 'rate_far':
      return ot('pago_movil.rate_far', { bcv: formatRate(bcvRate) })
    case 'whatsapp':
      return ot('pago_movil.whatsapp_error')
    case 'whatsapp_country':
      return ot('pago_movil.whatsapp_country')
    default: {
      const max =
        error.field === 'holder_name'
          ? ORDER_LIMITS.holder_name
          : error.field === 'bank_name'
            ? ORDER_LIMITS.bank_name
            : ORDER_LIMITS.instructions
      return ot('pago_movil.too_long', { max })
    }
  }
}

/** aria-* that tie a control to its label, hint, live line and error. */
function fieldAria(id: string, opts: { hint?: boolean; extra?: boolean; error?: string | null; invalid?: boolean }) {
  const describedBy = [opts.hint ? `${id}-hint` : null, opts.extra ? `${id}-extra` : null, opts.error ? `${id}-error` : null]
    .filter(Boolean)
    .join(' ')
  return {
    'aria-labelledby': `${id}-label`,
    'aria-describedby': describedBy || undefined,
    'aria-invalid': opts.error || opts.invalid ? true : undefined,
  }
}

export default function PagoMovilCard() {
  const { ot } = useOrdersT()
  const { sc } = useScT()
  const org = useOrg() as any
  const queryClient = useQueryClient()
  const { orgId, accessToken } = useOrdersAuth()
  const { data, isLoading, error } = useManualSettings()

  const [editOpen, setEditOpen] = useState<boolean | null>(null)
  const [edits, setEdits] = useState<ManualDraft | null>(null)
  const [bankOther, setBankOther] = useState<boolean | null>(null)
  const [attempted, setAttempted] = useState(false)
  const [apiErrors, setApiErrors] = useState<Partial<Record<ManualField, string>>>({})
  const [missing, setMissing] = useState<string[]>([])
  const [formError, setFormError] = useState<string | null>(null)
  const [busy, setBusy] = useState<Busy>(null)
  // Bumped after a failed save: the first field with an error gets the focus.
  const [focusTick, setFocusTick] = useState(0)
  const formRef = useRef<HTMLFormElement>(null)

  const saved = useMemo(() => (data ? draftFromManualSettings(data) : null), [data])
  const draft = edits ?? saved
  const bcvRate = bcvRateOf(data)
  const clientErrors = useMemo(() => (draft ? validateManualDraft(draft, { bcvRate }) : []), [draft, bcvRate])
  const dirty = !!(draft && saved && isManualDraftDirty(draft, saved))
  const ordersHref = getUriWithOrg(org?.slug, '/dash/orders')

  useEffect(() => {
    if (!focusTick) return
    formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus()
  }, [focusTick])

  if (isLoading) {
    return (
      <div className="border border-[#EAE8F2] rounded-xl px-5 py-4 flex items-center gap-4 animate-pulse">
        <div className="w-10 h-10 bg-gray-200 rounded-lg" />
        <div className="space-y-2">
          <div className="h-4 bg-gray-200 rounded w-28" />
          <div className="h-3 bg-gray-100 rounded w-48" />
        </div>
      </div>
    )
  }
  if (error || !data || !draft || !saved) {
    return (
      <div className="border border-[#EAE8F2] rounded-xl px-5 py-4 flex items-center gap-4">
        <div className="flex items-center justify-center w-10 h-10 bg-[#EEEDFF] rounded-lg shrink-0">
          <Smartphone size={20} className="text-[#6559CA]" aria-hidden />
        </div>
        <div className="min-w-0">
          <p className="font-semibold text-[#190933]">{ot('pago_movil.title')}</p>
          <p className="text-sm text-red-600">{ot('pago_movil.load_error')}</p>
        </div>
      </div>
    )
  }

  const editing = editOpen ?? !data.active
  const bankChoice = bankOther ? OTHER_BANK : bankByCode(draft.bank_code) ? draft.bank_code.trim() : draft.bank_code || draft.bank_name ? OTHER_BANK : ''
  const missingNow = data.active ? [] : (data.missing ?? [])

  const update = <K extends keyof ManualDraft>(field: K, value: ManualDraft[K]) => {
    setEdits({ ...draft, [field]: value })
    setApiErrors((prev) => {
      if (!(field in prev)) return prev
      const next = { ...prev }
      delete next[field as ManualField]
      return next
    })
  }

  const pickBank = (value: string) => {
    if (value === OTHER_BANK) {
      setBankOther(true)
      // A listed bank is cleared so she types hers; her own text stays.
      if (bankByCode(draft.bank_code)) setEdits({ ...draft, bank_name: '', bank_code: '' })
      return
    }
    const bank = bankByCode(value)
    if (!bank) return
    setBankOther(false)
    setEdits({ ...draft, bank_name: bank.name, bank_code: bank.code })
    setApiErrors((prev) => {
      const next = { ...prev }
      delete next.bank_name
      delete next.bank_code
      return next
    })
  }

  const errorFor = (field: ManualField): string | null => {
    if (apiErrors[field]) return apiErrors[field] as string
    if (attempted) {
      const clientError = clientErrors.find((e) => e.field === field)
      if (clientError) return clientErrorText(clientError, ot, bcvRate)
    }
    const value = draft[field as keyof ManualDraft]
    if (missing.includes(field) && typeof value === 'string' && !value.trim()) return ot('pago_movil.required_to_enable')
    return null
  }

  // fx_manual_rate is the only field that can be hidden while the form is open.
  const fieldVisible = (field: string) => field !== 'fx_manual_rate' || draft.fx_mode === 'manual'

  const resetForm = () => {
    setEdits(null)
    setBankOther(null)
    setAttempted(false)
    setApiErrors({})
    setMissing([])
    setFormError(null)
  }

  const put = async (body: ManualSettingsBody, kind: Exclude<Busy, null>, withForm: boolean) => {
    if (busy || !accessToken) return
    setBusy(kind)
    setFormError(null)
    setApiErrors({})
    setMissing([])
    try {
      const res = await updateManualSettings(orgId, body, accessToken)
      if (!res.success) {
        const code = errorCode(res.data)
        const message = describePaymentError(res.data, sc)
        if (code === 'INVALID_FIELD') {
          const field = errorField(res.data, 'field')
          if (field && (MANUAL_FIELDS as readonly string[]).includes(field)) {
            setApiErrors({ [field]: message })
            setEditOpen(true)
            // An error under a field she cannot see would go unnoticed.
            if (!fieldVisible(field)) setFormError(message)
            setFocusTick((tick) => tick + 1)
            return
          }
        }
        if (code === 'INCOMPLETE') {
          setMissing(errorList(res.data, 'missing'))
          setEditOpen(true)
          setFocusTick((tick) => tick + 1)
        }
        setFormError(message)
        return
      }
      queryClient.setQueryData<ManualSettings>(queryKeys.orders.manualSettings(orgId), res.data)
      queryClient.invalidateQueries({ queryKey: queryKeys.orders.manualSettings(orgId) })
      queryClient.invalidateQueries({ queryKey: queryKeys.payments.configs(orgId) })
      // The store's payment methods (the cart offers Pago Móvil only while it is on).
      queryClient.invalidateQueries({ queryKey: ['payments', orgId, 'checkout-providers'] })
      if (withForm) {
        resetForm()
        // Closes once everything required is there; stays open while incomplete.
        setEditOpen(null)
      }
      toast.success(
        kind === 'disable' ? ot('pago_movil.toggled_off') : kind === 'enable' ? ot('pago_movil.toggled_on') : ot('pago_movil.saved')
      )
    } catch {
      setFormError(ot('pago_movil.save_error'))
    } finally {
      setBusy(null)
    }
  }

  // Errors the form can see by itself stop the request (and say so).
  const blockedByForm = () => {
    setAttempted(true)
    if (clientErrors.length === 0) return false
    setFormError(ot('pago_movil.fix_fields'))
    setFocusTick((tick) => tick + 1)
    return true
  }

  const save = (e?: React.FormEvent) => {
    e?.preventDefault()
    if (blockedByForm()) return
    put(manualSettingsPayload(draft), 'save', true)
  }

  const toggle = (checked: boolean) => {
    if (!checked) {
      put({ enabled: false }, 'disable', false)
      return
    }
    // Turning on with unsaved changes saves them in the same request.
    if (editing && dirty) {
      if (blockedByForm()) return
      put({ ...manualSettingsPayload(draft), enabled: true }, 'enable', true)
      return
    }
    put({ enabled: true }, 'enable', false)
  }

  // Live lines under the WhatsApp and the manual rate.
  const whatsapp = whatsappInfo(draft.whatsapp)
  const whatsappError = errorFor('whatsapp')
  const whatsappLine = whatsappError ? null : whatsapp.missingCountry ? (
    <p id="pm-whatsapp-extra" className="text-xs font-medium text-amber-700">
      {ot('pago_movil.whatsapp_country')}
    </p>
  ) : whatsapp.preview ? (
    <p id="pm-whatsapp-extra" className="text-xs text-[#584F72]">
      {ot('pago_movil.whatsapp_preview', { number: whatsapp.preview })}
    </p>
  ) : null

  const rate = parseManualRate(draft.fx_manual_rate)
  const rateError = errorFor('fx_manual_rate')
  const rateFar = rate.ok && rateFarFromBcv(rate.value, bcvRate)
  const rateLiveError = !rateError && (rateFar || (!rate.ok && rate.code === 'ambiguous'))
  const rateLine = rateError ? null : rateFar ? (
    <p id="pm-rate-extra" className="text-xs font-medium text-red-600">
      {ot('pago_movil.rate_far', { bcv: formatRate(bcvRate) })}
    </p>
  ) : rate.ok ? (
    <p id="pm-rate-extra" className="text-xs font-medium text-[#4F43A4]">
      {ot('pago_movil.rate_preview', { rate: formatRatePreview(rate.value) })}
    </p>
  ) : rate.code === 'ambiguous' ? (
    <p id="pm-rate-extra" className="text-xs font-medium text-red-600">
      {ot('pago_movil.rate_ambiguous')}
    </p>
  ) : null

  const windowHours = parseWindowHours(draft.payment_window_hours)

  return (
    <div className="border border-[#EAE8F2] rounded-xl overflow-hidden">
      {/* Main row */}
      <div className="flex flex-wrap gap-3 items-center justify-between px-5 py-4 bg-white">
        <div className="flex items-center gap-4 min-w-0 flex-1 basis-64">
          <div className="flex items-center justify-center w-10 h-10 bg-[#EEEDFF] rounded-lg shrink-0">
            <Smartphone size={20} className="text-[#6559CA]" aria-hidden />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-semibold text-[#190933]">{ot('pago_movil.title')}</span>
              <StatusChip data={data} ot={ot} />
            </div>
            <p className="text-sm text-gray-500 mt-0.5">{ot('pago_movil.tagline')}</p>
            {missingNow.length > 0 && (
              <p className="text-xs text-amber-700 mt-1">
                {ot('pago_movil.missing', { fields: missingNow.map((f) => fieldLabel(ot, f)).join(', ') })}
              </p>
            )}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3 shrink-0 max-w-full">
          {!editing && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="text-xs rounded-full"
              disabled={!!busy}
              onClick={() => {
                resetForm()
                setEditOpen(true)
              }}
            >
              <Pencil size={12} className="me-1" aria-hidden />
              {ot('pago_movil.edit')}
            </Button>
          )}
          <div className="flex items-center gap-2 rounded-full border border-[#EAE8F2] bg-[#FFFCF9] py-1 ps-3 pe-1.5">
            <Label htmlFor="pago-movil-enabled" id="pago-movil-enabled-label" className="cursor-pointer text-sm text-[#190933]">
              {ot('pago_movil.toggle_label')}
            </Label>
            {(busy === 'enable' || busy === 'disable') && <Loader2 size={14} className="animate-spin text-gray-400" aria-hidden />}
            <Switch
              id="pago-movil-enabled"
              aria-labelledby="pago-movil-enabled-label"
              checked={!!data.enabled}
              disabled={!!busy}
              onCheckedChange={(checked) => toggle(checked === true)}
              className="data-[state=checked]:bg-[#7D75E2]"
            />
          </div>
        </div>
      </div>

      {formError && (
        <div role="alert" className="bg-amber-50 border-t border-amber-100 px-5 py-2.5 text-sm text-amber-900 flex items-start gap-2">
          <AlertTriangle size={14} className="shrink-0 mt-0.5" aria-hidden />
          <span>{formError}</span>
        </div>
      )}

      {editing ? (
        <form ref={formRef} onSubmit={save} className="border-t border-[#EAE8F2] bg-[#FFFCF9] px-5 py-5" autoComplete="off" noValidate>
          {/* Everything is read-only while a request runs. */}
          <fieldset disabled={!!busy} aria-busy={busy ? true : undefined} className="m-0 min-w-0 space-y-6 border-0 p-0">
            <fieldset className="space-y-4">
              <legend className="mb-3 text-sm font-semibold text-[#190933]">{ot('pago_movil.section_account')}</legend>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <Field id="pm-bank" label={ot('pago_movil.bank_label')} error={bankChoice === OTHER_BANK ? null : errorFor('bank_name') ?? errorFor('bank_code')}>
                  <select
                    id="pm-bank"
                    value={bankChoice}
                    onChange={(e) => pickBank(e.target.value)}
                    className={`${SELECT_CLASS} ${bankChoice === '' ? 'text-muted-foreground' : ''}`}
                    {...fieldAria('pm-bank', { error: bankChoice === OTHER_BANK ? null : errorFor('bank_name') ?? errorFor('bank_code') })}
                  >
                    <option value="" disabled>
                      {ot('pago_movil.bank_placeholder')}
                    </option>
                    {VE_BANKS.map((bank) => (
                      <option key={bank.code} value={bank.code}>
                        {bank.code} · {bank.name}
                      </option>
                    ))}
                    <option value={OTHER_BANK}>{ot('pago_movil.bank_other')}</option>
                  </select>
                </Field>
                {bankChoice === OTHER_BANK && (
                  <div className="grid grid-cols-[minmax(0,1fr)_8rem] gap-3 md:col-span-2">
                    <Field id="pm-bank-name" label={ot('pago_movil.bank_name_label')} error={errorFor('bank_name')}>
                      <Input
                        id="pm-bank-name"
                        value={draft.bank_name}
                        maxLength={ORDER_LIMITS.bank_name + 20}
                        onChange={(e) => update('bank_name', e.target.value)}
                        {...fieldAria('pm-bank-name', { error: errorFor('bank_name') })}
                      />
                    </Field>
                    <Field id="pm-bank-code" label={ot('pago_movil.bank_code_label')} hint={ot('pago_movil.bank_code_hint')} error={errorFor('bank_code')}>
                      <Input
                        id="pm-bank-code"
                        value={draft.bank_code}
                        inputMode="numeric"
                        maxLength={4}
                        onChange={(e) => update('bank_code', e.target.value.replace(/\D/g, '').slice(0, 4))}
                        className="font-mono"
                        {...fieldAria('pm-bank-code', { hint: true, error: errorFor('bank_code') })}
                      />
                    </Field>
                  </div>
                )}
                <Field id="pm-phone" label={ot('pago_movil.phone_label')} hint={ot('pago_movil.phone_hint')} error={errorFor('phone')}>
                  <Input
                    id="pm-phone"
                    type="tel"
                    inputMode="tel"
                    value={draft.phone}
                    onChange={(e) => update('phone', e.target.value)}
                    className="font-mono"
                    {...fieldAria('pm-phone', { hint: true, error: errorFor('phone') })}
                  />
                </Field>
                <Field id="pm-id" label={ot('pago_movil.id_document_label')} hint={ot('pago_movil.id_document_hint')} error={errorFor('id_document')}>
                  <Input
                    id="pm-id"
                    value={draft.id_document}
                    autoCapitalize="characters"
                    onChange={(e) => update('id_document', e.target.value)}
                    className="font-mono"
                    {...fieldAria('pm-id', { hint: true, error: errorFor('id_document') })}
                  />
                </Field>
                <Field id="pm-holder" label={ot('pago_movil.holder_label')} hint={ot('pago_movil.holder_hint')} error={errorFor('holder_name')}>
                  <Input
                    id="pm-holder"
                    value={draft.holder_name}
                    onChange={(e) => update('holder_name', e.target.value)}
                    {...fieldAria('pm-holder', { hint: true, error: errorFor('holder_name') })}
                  />
                </Field>
                <Field
                  id="pm-whatsapp"
                  label={ot('pago_movil.whatsapp_label')}
                  hint={ot('pago_movil.whatsapp_hint')}
                  error={whatsappError}
                  extra={whatsappLine}
                >
                  <Input
                    id="pm-whatsapp"
                    type="tel"
                    inputMode="tel"
                    value={draft.whatsapp}
                    onChange={(e) => update('whatsapp', e.target.value)}
                    className="font-mono"
                    {...fieldAria('pm-whatsapp', { hint: true, extra: !!whatsappLine, error: whatsappError })}
                  />
                </Field>
                <div className="md:col-span-2">
                  <Field
                    id="pm-instructions"
                    label={ot('pago_movil.instructions_label')}
                    hint={ot('pago_movil.instructions_hint')}
                    error={errorFor('instructions')}
                    counter={ot('char_count', { count: textLength(draft.instructions.trim()), max: ORDER_LIMITS.instructions })}
                    counterOver={textLength(draft.instructions.trim()) > ORDER_LIMITS.instructions}
                  >
                    <Textarea
                      id="pm-instructions"
                      rows={2}
                      value={draft.instructions}
                      onChange={(e) => update('instructions', e.target.value)}
                      {...fieldAria('pm-instructions', { hint: true, error: errorFor('instructions') })}
                    />
                  </Field>
                </div>
              </div>
            </fieldset>

            <fieldset className="space-y-4">
              <legend className="mb-3 text-sm font-semibold text-[#190933]">{ot('pago_movil.section_rules')}</legend>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <Field id="pm-window" label={ot('pago_movil.window_label')} hint={ot('pago_movil.window_hint')} error={errorFor('payment_window_hours')}>
                  <div className="flex items-center gap-2">
                    <Input
                      id="pm-window"
                      type="number"
                      inputMode="numeric"
                      min={ORDER_LIMITS.window_min}
                      max={ORDER_LIMITS.window_max}
                      step={1}
                      value={draft.payment_window_hours}
                      onChange={(e) => update('payment_window_hours', e.target.value)}
                      className="max-w-[7rem]"
                      {...fieldAria('pm-window', { hint: true, error: errorFor('payment_window_hours') })}
                    />
                    <span className="text-sm text-gray-500">{ot('pago_movil.window_unit', { count: windowHours ?? 2 })}</span>
                  </div>
                </Field>
                <div className="space-y-1.5">
                  <span id="pm-fx-label" className="block text-sm font-medium text-[#190933]">
                    {ot('pago_movil.fx_label')}
                  </span>
                  <div role="group" aria-labelledby="pm-fx-label" className="inline-flex rounded-full border border-[#EAE8F2] bg-white p-0.5">
                    {(['auto', 'manual'] as const).map((mode) => {
                      const active = draft.fx_mode === mode
                      return (
                        <button
                          key={mode}
                          type="button"
                          aria-pressed={active}
                          onClick={() => update('fx_mode', mode)}
                          className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                            active ? 'bg-[#190933] text-white' : 'text-[#584F72] hover:bg-[#EEEDFF]'
                          }`}
                        >
                          {mode === 'auto' ? ot('pago_movil.fx_auto') : ot('pago_movil.fx_manual')}
                        </button>
                      )
                    })}
                  </div>
                  {draft.fx_mode === 'manual' && (
                    <div className="pt-2">
                      <Field
                        id="pm-rate"
                        label={ot('pago_movil.fx_manual_label')}
                        hint={ot('pago_movil.fx_manual_hint')}
                        error={rateError}
                        extra={rateLine}
                      >
                        <Input
                          id="pm-rate"
                          inputMode="decimal"
                          value={draft.fx_manual_rate}
                          onChange={(e) => update('fx_manual_rate', e.target.value)}
                          className="max-w-[10rem] font-mono"
                          {...fieldAria('pm-rate', { hint: true, extra: !!rateLine, error: rateError, invalid: rateLiveError })}
                        />
                      </Field>
                    </div>
                  )}
                </div>
              </div>
            </fieldset>

            <fieldset className="space-y-4">
              <legend className="mb-3 text-sm font-semibold text-[#190933]">{ot('pago_movil.section_notices')}</legend>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <Field id="pm-notify" label={ot('pago_movil.notify_label')} hint={ot('pago_movil.notify_hint')} error={errorFor('notify_email')}>
                  <Input
                    id="pm-notify"
                    type="email"
                    inputMode="email"
                    value={draft.notify_email}
                    onChange={(e) => update('notify_email', e.target.value)}
                    {...fieldAria('pm-notify', { hint: true, error: errorFor('notify_email') })}
                  />
                </Field>
              </div>
            </fieldset>

            <div className="flex flex-wrap items-center justify-between gap-3">
              <p role="status" className="text-sm text-amber-700 min-h-5">
                {dirty ? ot('pago_movil.unsaved') : ''}
              </p>
              <div className="flex flex-wrap gap-2">
                {data.active && (
                  <Button
                    type="button"
                    variant="outline"
                    className="rounded-full"
                    onClick={() => {
                      resetForm()
                      setEditOpen(false)
                    }}
                  >
                    {ot('pago_movil.cancel')}
                  </Button>
                )}
                <Button type="submit" className="rounded-full bg-[#190933] text-white hover:bg-[#41375B]" aria-busy={busy === 'save' || undefined}>
                  {busy === 'save' && <Loader2 size={14} className="animate-spin" aria-hidden />}
                  {busy === 'save' ? ot('pago_movil.saving') : ot('pago_movil.save')}
                </Button>
              </div>
            </div>
          </fieldset>
        </form>
      ) : (
        <SavedSummary data={data} ot={ot} />
      )}

      <FxAndHelp data={data} ot={ot} ordersHref={ordersHref} />
    </div>
  )
}

function StatusChip({ data, ot }: { data: ManualSettings; ot: OrdersTranslate }) {
  if (!data.active) {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-amber-800 bg-amber-100 px-2 py-0.5 rounded-full">
        <AlertTriangle size={10} aria-hidden />
        <span>{ot('pago_movil.chip_incomplete')}</span>
      </span>
    )
  }
  if (data.enabled) {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-green-700 bg-green-100 px-2 py-0.5 rounded-full">
        <CheckCircle2 size={10} aria-hidden />
        <span>{ot('pago_movil.chip_active')}</span>
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-1 text-xs text-gray-600 bg-gray-100 px-2 py-0.5 rounded-full">
      <CircleOff size={10} aria-hidden />
      <span>{ot('pago_movil.chip_disabled')}</span>
    </span>
  )
}

/**
 * Label, control, hint, live line and error of one field. Ids: `${id}-label`,
 * `${id}-hint`, `${id}-extra` (the `extra` element sets its own) and
 * `${id}-error`; fieldAria() ties the control to them.
 */
function Field({
  id,
  label,
  hint,
  error,
  extra,
  counter,
  counterOver,
  children,
}: {
  id: string
  label: string
  hint?: string
  error?: string | null
  extra?: React.ReactNode
  counter?: string
  counterOver?: boolean
  children: React.ReactNode
}) {
  // A field with an error gets a red border, whatever control it holds.
  const invalid = error ? '[&_input]:border-red-400 [&_select]:border-red-400 [&_textarea]:border-red-400' : ''
  return (
    <div className={`space-y-1.5 min-w-0 ${invalid}`}>
      <div className="flex items-baseline justify-between gap-3">
        <Label htmlFor={id} id={`${id}-label`} className="text-[#190933]">
          {label}
        </Label>
        {counter && (
          <span className={`text-xs tabular-nums ${counterOver ? 'font-semibold text-red-600' : 'text-gray-400'}`}>{counter}</span>
        )}
      </div>
      {children}
      {hint && (
        <p id={`${id}-hint`} className="text-xs text-gray-500">
          {hint}
        </p>
      )}
      {extra}
      {error && (
        <p id={`${id}-error`} role="alert" className="text-xs font-medium text-red-600">
          {error}
        </p>
      )}
    </div>
  )
}

function SavedSummary({ data, ot }: { data: ManualSettings; ot: OrdersTranslate }) {
  const s = data.settings
  const bank = [s.bank_name, s.bank_code ? `(${s.bank_code})` : ''].filter(Boolean).join(' ')
  const whatsapp = whatsappInfo(s.whatsapp)
  const rows: Array<{ label: string; value: string; mono?: boolean; wide?: boolean }> = [
    { label: ot('pago_movil.bank_label'), value: bank || '—' },
    { label: ot('pago_movil.phone_label'), value: s.phone || '—', mono: true },
    { label: ot('pago_movil.id_document_label'), value: s.id_document || '—', mono: true },
    { label: ot('detail.holder'), value: s.holder_name || '—' },
    { label: ot('pago_movil.whatsapp_label'), value: whatsapp.preview || s.whatsapp || '—', mono: true },
    { label: ot('pago_movil.window_label'), value: ot('pago_movil.summary_window', { count: Number(s.payment_window_hours) || 0 }) },
    {
      label: ot('pago_movil.fx_label'),
      value:
        s.fx_mode === 'manual'
          ? ot('pago_movil.summary_fx_manual', { rate: formatRate(s.fx_manual_rate) })
          : ot('pago_movil.fx_auto'),
    },
    { label: ot('fields.notify_email'), value: s.notify_email || ot('pago_movil.summary_notify_none') },
  ]
  if (s.instructions) rows.push({ label: ot('detail.instructions'), value: s.instructions, wide: true })
  return (
    <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2 px-5 py-3 border-t border-[#EAE8F2] bg-[#FFFCF9] text-xs">
      {rows.map((row) => (
        <div key={row.label} className={`min-w-0 ${row.wide ? 'sm:col-span-2' : ''}`}>
          <dt className="text-gray-400 first-letter:uppercase">{row.label}</dt>
          <dd className={`text-gray-700 [overflow-wrap:anywhere] ${row.mono ? 'font-mono' : ''}`}>{row.value}</dd>
        </div>
      ))}
    </dl>
  )
}

function FxAndHelp({ data, ot, ordersHref }: { data: ManualSettings; ot: OrdersTranslate; ordersHref: string }) {
  const fx = data.fx
  let today: string | null = null
  if (fx && fx.rate !== null && fx.rate !== undefined) {
    const rate = formatRate(fx.rate)
    today =
      fx.source === 'manual'
        ? ot('pago_movil.fx_today_manual', { rate })
        : fx.rate_date
          ? ot('pago_movil.fx_today_bcv', { rate, date: formatIsoDate(fx.rate_date) })
          : ot('pago_movil.fx_today_bcv_undated', { rate })
    if (fx.stale) today = `${today} ${ot('pago_movil.fx_stale')}`
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
            {fx.error} {ot('pago_movil.fx_error_hint')}
          </span>
        </p>
      )}
      <p className="flex items-start gap-2 text-xs text-[#584F72]">
        <Info size={13} className="mt-0.5 shrink-0 text-[#7D75E2]" aria-hidden />
        <span>
          {ot('pago_movil.help')}{' '}
          <Link href={ordersHref} className="font-medium text-[#4F43A4] underline underline-offset-2">
            {ot('pago_movil.go_to_orders')}
          </Link>
        </span>
      </p>
    </div>
  )
}
