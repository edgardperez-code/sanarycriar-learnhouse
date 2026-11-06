'use client'
// Sanar y Criar: "Pago Móvil" card of Pagos → Configuración (cart contract
// §C.5): the bank account that receives the payments and the switch. The
// WhatsApp for the receipts, the time to pay, the exchange rate and the
// notice e-mail are shared by every manual method and live in
// ManualSettingsCard; this card saves only its own fields (PUT
// /manual/settings with just those, so the shared ones stay as they are).
//
// The switch saves right away: turning it on while the form has changes saves
// them too, and the API answers INCOMPLETE when a required field is missing
// (a missing WhatsApp or manual rate is named "en Ajustes de los pagos
// manuales", where they are set). Formats are checked by the API, which names
// the wrong field (INVALID_FIELD); the error shows under it and the focus goes
// to the first field with an error.
import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import { Input } from '@components/ui/input'
import { Textarea } from '@components/ui/textarea'
import { useScT } from '@components/Payments/useScT'
import { describePaymentError, errorCode, errorField, methodLabel } from '@components/Payments/commerce'
import { updateManualSettings } from '@services/payments/orders'
import { queryKeys } from '@/lib/query/keys'
import {
  ManualDraft,
  ManualField,
  ManualFieldError,
  ManualSettings,
  ManualSettingsBody,
  ORDER_LIMITS,
  OTHER_BANK,
  PAGO_MOVIL_FIELDS,
  bankByCode,
  bankChoiceFor,
  bankText,
  draftFromManualSettings,
  errorList,
  isPagoMovilDraftDirty,
  pagoMovilPayload,
  splitMissing,
  textLength,
  validatePagoMovilDraft,
} from '../Orders/ordersForm'
import { MethodIcon } from '../Orders/OrderBits'
import { useManualSettings, useOrdersAuth } from '../Orders/useOrdersApi'
import { OrdersTranslate, useOrdersT } from '../Orders/useOrdersT'
import {
  BankFields,
  CardFormError,
  CardHeader,
  CardLoadError,
  CardSkeleton,
  CardStatusChip,
  CardSwitch,
  EditButton,
  Field,
  FormFooter,
  MissingLine,
  SavedRow,
  SavedSummary,
  fieldAria,
  missingText,
  useRefreshManual,
} from './ManualCardParts'

type Busy = 'save' | 'enable' | 'disable' | null
type PagoMovilField = (typeof PAGO_MOVIL_FIELDS)[number]

const isOwnField = (field: string): field is PagoMovilField => (PAGO_MOVIL_FIELDS as readonly string[]).includes(field)

function clientErrorText(error: ManualFieldError, ot: OrdersTranslate): string {
  if (error.code === 'bank_name') return ot('bank.name_error')
  const max = error.field === 'holder_name' ? ORDER_LIMITS.holder_name : ORDER_LIMITS.instructions
  return ot('manual_card.too_long', { max })
}

export default function PagoMovilCard() {
  const { ot } = useOrdersT()
  const { sc } = useScT()
  const queryClient = useQueryClient()
  const refresh = useRefreshManual()
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
  const clientErrors = useMemo(() => (draft ? validatePagoMovilDraft(draft) : []), [draft])
  const dirty = !!(draft && saved && isPagoMovilDraftDirty(draft, saved))
  const title = methodLabel('pago_movil', sc)

  useEffect(() => {
    if (!focusTick) return
    formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus()
  }, [focusTick])

  if (isLoading) return <CardSkeleton />
  if (error || !data || !draft || !saved) {
    return <CardLoadError icon={<MethodIcon method="pago_movil" size={20} />} title={title} message={ot('pago_movil.load_error')} />
  }

  const missingNow = data.active ? [] : (data.missing ?? [])
  // Open while its own data is incomplete (a missing WhatsApp or manual rate is set in the common card).
  const ownIncomplete = splitMissing(missingNow).own.length > 0
  const editing = editOpen ?? ownIncomplete
  const bankChoice = bankOther ? OTHER_BANK : bankChoiceFor(draft.bank_code, draft.bank_name)

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

  const errorFor = (field: PagoMovilField): string | null => {
    if (apiErrors[field]) return apiErrors[field] as string
    if (attempted) {
      const clientError = clientErrors.find((e) => e.field === field)
      if (clientError) return clientErrorText(clientError, ot)
    }
    if (missing.includes(field) && !draft[field].trim()) return ot('pago_movil.required_to_enable')
    return null
  }

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
          if (field && isOwnField(field)) {
            setApiErrors({ [field]: message })
            setEditOpen(true)
            setFocusTick((tick) => tick + 1)
            return
          }
        }
        if (code === 'INCOMPLETE') {
          const list = errorList(res.data, 'missing')
          setMissing(list)
          // Only the shared data missing (set in the common card): nothing to fill here.
          if (list.length === 0 || splitMissing(list).own.length > 0) {
            setEditOpen(true)
            setFocusTick((tick) => tick + 1)
          }
          // Named here, with "en Ajustes de los pagos manuales" for the shared
          // ones (the API's own text lists every required field).
          setFormError(list.length ? ot('pago_movil.incomplete', { fields: missingText(ot, list) }) : message)
          return
        }
        setFormError(message)
        return
      }
      queryClient.setQueryData<ManualSettings>(queryKeys.orders.manualSettings(orgId), res.data)
      refresh(orgId)
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
    setFormError(ot('manual_card.fix_fields'))
    setFocusTick((tick) => tick + 1)
    return true
  }

  const save = (e?: React.FormEvent) => {
    e?.preventDefault()
    if (blockedByForm()) return
    put(pagoMovilPayload(draft), 'save', true)
  }

  const toggle = (checked: boolean) => {
    if (!checked) {
      put({ enabled: false }, 'disable', false)
      return
    }
    // Turning on with unsaved changes saves them in the same request.
    if (editing && dirty) {
      if (blockedByForm()) return
      put({ ...pagoMovilPayload(draft), enabled: true }, 'enable', true)
      return
    }
    put({ enabled: true }, 'enable', false)
  }

  const instructionsLength = textLength(draft.instructions.trim())

  return (
    <div className="border border-[#EAE8F2] rounded-xl overflow-hidden">
      <CardHeader
        icon={<MethodIcon method="pago_movil" size={20} />}
        title={title}
        chip={<CardStatusChip active={!!data.active} enabled={!!data.enabled} ot={ot} />}
        tagline={ot('pago_movil.tagline')}
        notes={<MissingLine missing={missingNow} ot={ot} />}
        actions={
          <>
            {!editing && (
              <EditButton
                label={ot('manual_card.edit')}
                disabled={!!busy}
                onClick={() => {
                  resetForm()
                  setEditOpen(true)
                }}
              />
            )}
            <CardSwitch
              id="pago-movil-enabled"
              label={ot('pago_movil.toggle_label')}
              checked={!!data.enabled}
              busy={busy === 'enable' || busy === 'disable'}
              disabled={!!busy}
              onChange={toggle}
            />
          </>
        }
      />

      <CardFormError message={formError} />

      {editing ? (
        <form ref={formRef} onSubmit={save} className="border-t border-[#EAE8F2] bg-[#FFFCF9] px-5 py-5" autoComplete="off" noValidate>
          {/* Everything is read-only while a request runs. */}
          <fieldset disabled={!!busy} aria-busy={busy ? true : undefined} className="m-0 min-w-0 space-y-6 border-0 p-0">
            <fieldset className="space-y-4">
              <legend className="mb-3 text-sm font-semibold text-[#190933]">{ot('pago_movil.section_account')}</legend>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <BankFields
                  idp="pm"
                  ot={ot}
                  name={draft.bank_name}
                  code={draft.bank_code}
                  choice={bankChoice}
                  onPick={pickBank}
                  onName={(value) => update('bank_name', value)}
                  onCode={(value) => update('bank_code', value)}
                  nameError={errorFor('bank_name')}
                  codeError={errorFor('bank_code')}
                  codeHint={ot('bank.code_hint')}
                />
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
                <Field id="pm-id" label={ot('manual_card.id_document_label')} hint={ot('manual_card.id_document_hint')} error={errorFor('id_document')}>
                  <Input
                    id="pm-id"
                    value={draft.id_document}
                    autoCapitalize="characters"
                    onChange={(e) => update('id_document', e.target.value)}
                    className="font-mono"
                    {...fieldAria('pm-id', { hint: true, error: errorFor('id_document') })}
                  />
                </Field>
                <Field id="pm-holder" label={ot('pago_movil.holder_label')} hint={ot('manual_card.holder_hint_bank')} error={errorFor('holder_name')}>
                  <Input
                    id="pm-holder"
                    value={draft.holder_name}
                    onChange={(e) => update('holder_name', e.target.value)}
                    {...fieldAria('pm-holder', { hint: true, error: errorFor('holder_name') })}
                  />
                </Field>
                <div className="md:col-span-2">
                  <Field
                    id="pm-instructions"
                    label={ot('manual_card.instructions_label')}
                    hint={ot('manual_card.instructions_hint_bank')}
                    error={errorFor('instructions')}
                    counter={ot('char_count', { count: instructionsLength, max: ORDER_LIMITS.instructions })}
                    counterOver={instructionsLength > ORDER_LIMITS.instructions}
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

            <FormFooter
              ot={ot}
              dirty={dirty}
              canCancel={!ownIncomplete}
              saving={busy === 'save'}
              onCancel={() => {
                resetForm()
                setEditOpen(false)
              }}
            />
          </fieldset>
        </form>
      ) : (
        <PagoMovilSummary data={data} ot={ot} />
      )}
    </div>
  )
}

function PagoMovilSummary({ data, ot }: { data: ManualSettings; ot: OrdersTranslate }) {
  const s = data.settings
  const rows: SavedRow[] = [
    { label: ot('bank.label'), value: bankText(s.bank_name, s.bank_code) || '—' },
    { label: ot('pago_movil.phone_label'), value: s.phone || '—', mono: true },
    { label: ot('manual_card.id_document_label'), value: s.id_document || '—', mono: true },
    { label: ot('detail.holder'), value: s.holder_name || '—' },
  ]
  if (s.instructions) rows.push({ label: ot('detail.instructions'), value: s.instructions, wide: true })
  return <SavedSummary rows={rows} />
}
