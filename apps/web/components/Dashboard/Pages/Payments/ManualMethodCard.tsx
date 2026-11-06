'use client'
// Sanar y Criar: the card of a manual method other than Pago Móvil in Pagos ›
// Configuración (manual methods contract §A.2, §A.3): bank transfer, Zelle or
// Binance. Same look and behaviour as PagoMovilCard: status chip, "Falta: …",
// Edit / Save / Cancel and a switch that saves right away (turning it on with
// unsaved changes saves them in the same request). One query for the three
// (GET /manual/methods); each saves with PUT /manual/methods/{method}.
//
// The form checks the API's rules first (validateMethodDraft), so every error
// shows at once; the API checks them again and names the wrong field
// (INVALID_FIELD), shown under it with the focus there. Switching on with
// missing data answers INCOMPLETE: the missing fields are marked, and the
// shared ones (the WhatsApp, the manual rate) are named "en Ajustes de los
// pagos manuales", where they are set.
//
// A card she never filled starts closed (most of the time only some methods
// are used); once it has data it opens while incomplete, like Pago Móvil's.
import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import { Input } from '@components/ui/input'
import { Textarea } from '@components/ui/textarea'
import { useScT } from '@components/Payments/useScT'
import { describePaymentError, errorCode, errorField, methodLabel } from '@components/Payments/commerce'
import { updateManualMethod } from '@services/payments/orders'
import { queryKeys } from '@/lib/query/keys'
import {
  ACCOUNT_DIGITS,
  ACCOUNT_TYPES,
  ExtraMethod,
  METHOD_FIELDS,
  ManualMethodBody,
  ManualMethodState,
  ManualMethods,
  MethodDraft,
  MethodField,
  MethodFieldError,
  ORDER_LIMITS,
  OTHER_BANK,
  USDT_NETWORKS,
  accountInfo,
  addressMatchesNetwork,
  bankByCode,
  bankChoiceFor,
  bankText,
  errorList,
  formatAccountNumber,
  formatZellePhone,
  isMethodDraftDirty,
  methodDraftFromState,
  methodHasData,
  methodPayload,
  missingTokenFor,
  networkLabel,
  splitMissing,
  textLength,
  validateMethodDraft,
} from '../Orders/ordersForm'
import { MethodIcon } from '../Orders/OrderBits'
import { useManualMethods, useOrdersAuth } from '../Orders/useOrdersApi'
import { OrdersTranslate, accountTypeLabel, useOrdersT } from '../Orders/useOrdersT'
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
  SELECT_CLASS,
  SavedRow,
  SavedSummary,
  fieldAria,
  missingText,
  useRefreshManual,
} from './ManualCardParts'

type Busy = 'save' | 'enable' | 'disable' | null

/** The texts that change from one method to another (literal keys, for the i18n checks). */
type MethodTexts = {
  tagline: string
  toggle: string
  toggledOn: string
  toggledOff: string
  saved: string
  /** Under an empty field that switching on needs. */
  required: string
  /** "Para activar Zelle falta: …." */
  incomplete: (_fields: string) => string
}

function methodTexts(method: ExtraMethod, ot: OrdersTranslate): MethodTexts {
  switch (method) {
    case 'transferencia':
      return {
        tagline: ot('transferencia.tagline'),
        toggle: ot('transferencia.toggle_label'),
        toggledOn: ot('transferencia.toggled_on'),
        toggledOff: ot('transferencia.toggled_off'),
        saved: ot('transferencia.saved'),
        required: ot('transferencia.required_to_enable'),
        incomplete: (fields) => ot('transferencia.incomplete', { fields }),
      }
    case 'zelle':
      return {
        tagline: ot('zelle.tagline'),
        toggle: ot('zelle.toggle_label'),
        toggledOn: ot('zelle.toggled_on'),
        toggledOff: ot('zelle.toggled_off'),
        saved: ot('zelle.saved'),
        required: ot('zelle.required_to_enable'),
        incomplete: (fields) => ot('zelle.incomplete', { fields }),
      }
    default:
      return {
        tagline: ot('binance.tagline'),
        toggle: ot('binance.toggle_label'),
        toggledOn: ot('binance.toggled_on'),
        toggledOff: ot('binance.toggled_off'),
        saved: ot('binance.saved'),
        required: ot('binance.required_to_enable'),
        incomplete: (fields) => ot('binance.incomplete', { fields }),
      }
  }
}

/** Why an empty field is needed: the method's text, or the "one of the two" ones. */
function requiredText(token: string, texts: MethodTexts, ot: OrdersTranslate): string {
  if (token === 'email_or_phone') return ot('zelle.email_or_phone_required')
  if (token === 'pay_id_or_address') return ot('binance.pay_id_or_address_required')
  if (token === 'usdt_network') return ot('method_errors.network_required')
  return texts.required
}

function clientErrorText(error: MethodFieldError, ot: OrdersTranslate): string {
  switch (error.code) {
    case 'bank_name':
      return ot('bank.name_error')
    case 'bank_code':
      return ot('method_errors.bank_code')
    case 'account_number':
      return ot('method_errors.account_number')
    case 'account_bank':
      return ot('method_errors.account_bank', { code: error.bankCode ?? '' })
    case 'id_document':
      return ot('method_errors.id_document')
    case 'email':
      return ot('method_errors.email')
    case 'zelle_phone':
      return ot('method_errors.zelle_phone')
    case 'pay_id':
      return ot('method_errors.pay_id')
    case 'usdt_address':
      return ot('method_errors.usdt_address')
    case 'address_network':
      return ot('method_errors.address_network', { network: networkLabel(error.network) })
    case 'network_required':
      return ot('method_errors.network_required')
    default:
      return ot('manual_card.too_long', { max: error.max ?? ORDER_LIMITS.instructions })
  }
}

/** Prefix of the ids of each card's fields. */
const ID_PREFIX: Record<ExtraMethod, string> = { transferencia: 'tr', zelle: 'ze', binance: 'bi' }

/** Fields the API checks together: changing the first one clears the API's error on the others. */
const LINKED_FIELDS: Partial<Record<MethodField, MethodField[]>> = {
  bank_code: ['account_number'],
  usdt_network: ['usdt_address'],
}

type FieldsProps = {
  idp: string
  ot: OrdersTranslate
  draft: MethodDraft
  update: (_field: MethodField, _value: string) => void
  errorFor: (_field: MethodField) => string | null
}

export default function ManualMethodCard({ method }: { method: ExtraMethod }) {
  const { ot } = useOrdersT()
  const { sc } = useScT()
  const queryClient = useQueryClient()
  const refresh = useRefreshManual()
  const { orgId, accessToken } = useOrdersAuth()
  const { data: methods, isLoading, error } = useManualMethods()
  const state = methods?.[method]

  const [editOpen, setEditOpen] = useState<boolean | null>(null)
  const [edits, setEdits] = useState<MethodDraft | null>(null)
  const [bankOther, setBankOther] = useState<boolean | null>(null)
  const [attempted, setAttempted] = useState(false)
  const [apiErrors, setApiErrors] = useState<Partial<Record<MethodField, string>>>({})
  const [missing, setMissing] = useState<string[]>([])
  const [formError, setFormError] = useState<string | null>(null)
  const [busy, setBusy] = useState<Busy>(null)
  // Bumped after a failed save: the first field with an error gets the focus.
  const [focusTick, setFocusTick] = useState(0)
  const formRef = useRef<HTMLFormElement>(null)

  const saved = useMemo(() => (state ? methodDraftFromState(method, state) : null), [method, state])
  const draft = edits ?? saved
  const clientErrors = useMemo(() => (draft ? validateMethodDraft(method, draft) : []), [method, draft])
  const dirty = !!(draft && saved && isMethodDraftDirty(method, draft, saved))
  const title = methodLabel(method, sc)
  const texts = methodTexts(method, ot)
  const idp = ID_PREFIX[method]
  const icon = <MethodIcon method={method} size={20} />

  useEffect(() => {
    if (!focusTick) return
    formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus()
  }, [focusTick])

  if (isLoading) return <CardSkeleton />
  if (error || !state || !draft || !saved) {
    return <CardLoadError icon={icon} title={title} message={ot('manual_card.load_error')} />
  }

  const touched = methodHasData(state)
  const missingNow = state.active ? [] : (state.missing ?? [])
  // Its own data is incomplete (a missing WhatsApp or manual rate is set in the common card).
  const ownIncomplete = splitMissing(missingNow).own.length > 0
  const editing = editOpen ?? (ownIncomplete && touched)
  // Closing leaves a coherent card: its own data complete, or never filled.
  const canClose = !ownIncomplete || !touched
  const bankChoice = bankOther ? OTHER_BANK : bankChoiceFor(draft.bank_code, draft.bank_name)

  const clearApiErrors = (...fields: MethodField[]) =>
    setApiErrors((prev) => {
      if (!fields.some((field) => field in prev)) return prev
      const next = { ...prev }
      for (const field of fields) delete next[field]
      return next
    })

  const update = (field: MethodField, value: string) => {
    setEdits({ ...draft, [field]: value })
    // The account is checked against the bank code, and the address against its network.
    clearApiErrors(field, ...(LINKED_FIELDS[field] ?? []))
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
    clearApiErrors('bank_name', 'bank_code', 'account_number')
  }

  const errorFor = (field: MethodField): string | null => {
    if (apiErrors[field]) return apiErrors[field] as string
    if (attempted) {
      const clientError = clientErrors.find((e) => e.field === field)
      if (clientError) return clientErrorText(clientError, ot)
    }
    const token = missingTokenFor(field, missing)
    if (token && !String(draft[field] ?? '').trim()) return requiredText(token, texts, ot)
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

  const put = async (body: ManualMethodBody, kind: Exclude<Busy, null>, withForm: boolean) => {
    if (busy || !accessToken) return
    setBusy(kind)
    setFormError(null)
    setApiErrors({})
    setMissing([])
    try {
      const res = await updateManualMethod(orgId, method, body, accessToken)
      if (!res.success) {
        const code = errorCode(res.data)
        const message = describePaymentError(res.data, sc)
        if (code === 'INVALID_FIELD') {
          const field = errorField(res.data, 'field')
          if (field && (METHOD_FIELDS[method] as readonly string[]).includes(field)) {
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
          setFormError(list.length ? texts.incomplete(missingText(ot, list)) : message)
          return
        }
        setFormError(message)
        return
      }
      const fresh = res.data as ManualMethodState
      queryClient.setQueryData<ManualMethods>(queryKeys.orders.manualMethods(orgId), (old) => ({ ...(old ?? {}), [method]: fresh }))
      refresh(orgId)
      if (withForm) {
        resetForm()
        // Closes once everything required is there; stays open while incomplete.
        setEditOpen(null)
      }
      toast.success(kind === 'disable' ? texts.toggledOff : kind === 'enable' ? texts.toggledOn : texts.saved)
    } catch {
      setFormError(ot('manual_card.save_error'))
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
    put(methodPayload(method, draft), 'save', true)
  }

  const toggle = (checked: boolean) => {
    if (!checked) {
      put({ enabled: false }, 'disable', false)
      return
    }
    // Turning on with unsaved changes saves them in the same request.
    if (editing && dirty) {
      if (blockedByForm()) return
      put({ ...methodPayload(method, draft), enabled: true }, 'enable', true)
      return
    }
    put({ enabled: true }, 'enable', false)
  }

  const fieldsProps: FieldsProps = { idp, ot, draft, update, errorFor }
  const instructionsLength = textLength(draft.instructions.trim())
  const instructionsHint =
    method === 'zelle'
      ? ot('zelle.instructions_hint')
      : method === 'binance'
        ? ot('binance.instructions_hint')
        : ot('manual_card.instructions_hint_bank')

  return (
    <div className="border border-[#EAE8F2] rounded-xl overflow-hidden">
      <CardHeader
        icon={icon}
        title={title}
        chip={<CardStatusChip active={!!state.active} enabled={!!state.enabled} ot={ot} />}
        tagline={texts.tagline}
        notes={<MissingLine missing={missingNow} ot={ot} />}
        actions={
          <>
            {!editing && (
              <EditButton
                label={touched ? ot('manual_card.edit') : ot('manual_card.setup')}
                disabled={!!busy}
                onClick={() => {
                  resetForm()
                  setEditOpen(true)
                }}
              />
            )}
            <CardSwitch
              id={`${idp}-enabled`}
              label={texts.toggle}
              checked={!!state.enabled}
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
              {method === 'transferencia' ? (
                <TransferenciaFields {...fieldsProps} bankChoice={bankChoice} pickBank={pickBank} />
              ) : method === 'zelle' ? (
                <ZelleFields {...fieldsProps} />
              ) : (
                <BinanceFields {...fieldsProps} />
              )}
              <Field
                id={`${idp}-instructions`}
                label={ot('manual_card.instructions_label')}
                hint={instructionsHint}
                error={errorFor('instructions')}
                counter={ot('char_count', { count: instructionsLength, max: ORDER_LIMITS.instructions })}
                counterOver={instructionsLength > ORDER_LIMITS.instructions}
              >
                <Textarea
                  id={`${idp}-instructions`}
                  rows={2}
                  value={draft.instructions}
                  onChange={(e) => update('instructions', e.target.value)}
                  {...fieldAria(`${idp}-instructions`, { hint: true, error: errorFor('instructions') })}
                />
              </Field>
            </fieldset>

            <FormFooter
              ot={ot}
              dirty={dirty}
              canCancel={canClose}
              saving={busy === 'save'}
              onCancel={() => {
                resetForm()
                setEditOpen(false)
              }}
            />
          </fieldset>
        </form>
      ) : touched ? (
        <SavedSummary rows={summaryRows(method, state, ot)} />
      ) : null}
    </div>
  )
}

// ---------------------------------------------------------------------------
// The fields of each method
// ---------------------------------------------------------------------------

function TransferenciaFields({
  idp,
  ot,
  draft,
  update,
  errorFor,
  bankChoice,
  pickBank,
}: FieldsProps & { bankChoice: string; pickBank: (_value: string) => void }) {
  // Live line under the account: how many digits, then the 20 grouped, or why
  // it does not match the bank (the API refuses that one too).
  const account = accountInfo(draft.account_number, draft.bank_code)
  const accountError = errorFor('account_number')
  const accountLine = accountError ? null : account.bankMismatch ? (
    <p id={`${idp}-account-extra`} className="text-xs font-medium text-red-600">
      {ot('method_errors.account_bank', { code: draft.bank_code.trim() })}
    </p>
  ) : account.grouped ? (
    <p id={`${idp}-account-extra`} className="text-xs font-medium text-[#4F43A4]">
      {ot('transferencia.account_preview', { number: account.grouped })}
    </p>
  ) : account.digits && account.numeric ? (
    <p
      id={`${idp}-account-extra`}
      className={`text-xs tabular-nums ${account.digits.length > ACCOUNT_DIGITS ? 'font-medium text-amber-700' : 'text-[#584F72]'}`}
    >
      {ot('transferencia.account_count', { digits: account.digits.length, total: ACCOUNT_DIGITS })}
    </p>
  ) : null
  const typeError = errorFor('account_type')

  return (
    <>
      <legend className="mb-3 text-sm font-semibold text-[#190933]">{ot('transferencia.section_account')}</legend>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <BankFields
          idp={idp}
          ot={ot}
          name={draft.bank_name}
          code={draft.bank_code}
          choice={bankChoice}
          onPick={pickBank}
          onName={(value) => update('bank_name', value)}
          onCode={(value) => update('bank_code', value)}
          nameError={errorFor('bank_name')}
          codeError={errorFor('bank_code')}
          codeHint={ot('bank.code_hint_transfer')}
        />
        <Field
          id={`${idp}-account`}
          label={ot('transferencia.account_number_label')}
          hint={ot('transferencia.account_number_hint')}
          error={accountError}
          extra={accountLine}
        >
          <Input
            id={`${idp}-account`}
            inputMode="numeric"
            value={draft.account_number}
            maxLength={ACCOUNT_DIGITS + 10}
            onChange={(e) => update('account_number', e.target.value)}
            className="font-mono"
            {...fieldAria(`${idp}-account`, { hint: true, extra: !!accountLine, error: accountError, invalid: account.bankMismatch })}
          />
        </Field>
        <Field id={`${idp}-type`} label={ot('transferencia.account_type_label')} error={typeError}>
          <select
            id={`${idp}-type`}
            value={draft.account_type}
            onChange={(e) => update('account_type', e.target.value)}
            className={`${SELECT_CLASS} ${draft.account_type === '' ? 'text-muted-foreground' : ''}`}
            {...fieldAria(`${idp}-type`, { error: typeError })}
          >
            <option value="" disabled>
              {ot('transferencia.account_type_choose')}
            </option>
            {ACCOUNT_TYPES.map((type) => (
              <option key={type} value={type}>
                {accountTypeLabel(ot, type)}
              </option>
            ))}
          </select>
        </Field>
        <Field id={`${idp}-holder`} label={ot('transferencia.holder_label')} hint={ot('manual_card.holder_hint_bank')} error={errorFor('holder_name')}>
          <Input
            id={`${idp}-holder`}
            value={draft.holder_name}
            onChange={(e) => update('holder_name', e.target.value)}
            {...fieldAria(`${idp}-holder`, { hint: true, error: errorFor('holder_name') })}
          />
        </Field>
        <Field
          id={`${idp}-id`}
          label={ot('manual_card.id_document_label')}
          hint={ot('manual_card.id_document_hint')}
          error={errorFor('id_document')}
        >
          <Input
            id={`${idp}-id`}
            value={draft.id_document}
            autoCapitalize="characters"
            onChange={(e) => update('id_document', e.target.value)}
            className="font-mono"
            {...fieldAria(`${idp}-id`, { hint: true, error: errorFor('id_document') })}
          />
        </Field>
      </div>
    </>
  )
}

function ZelleFields({ idp, ot, draft, update, errorFor }: FieldsProps) {
  const phoneError = errorFor('phone')
  const phonePreview = formatZellePhone(draft.phone)
  const phoneLine =
    !phoneError && phonePreview ? (
      <p id={`${idp}-phone-extra`} className="text-xs text-[#584F72]">
        {ot('zelle.phone_preview', { number: phonePreview })}
      </p>
    ) : null
  return (
    <>
      <legend className="mb-3 text-sm font-semibold text-[#190933]">{ot('zelle.section_account')}</legend>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Field id={`${idp}-email`} label={ot('zelle.email_label')} hint={ot('zelle.email_hint')} error={errorFor('email')}>
          <Input
            id={`${idp}-email`}
            type="email"
            inputMode="email"
            autoCapitalize="none"
            spellCheck={false}
            value={draft.email}
            onChange={(e) => update('email', e.target.value)}
            {...fieldAria(`${idp}-email`, { hint: true, error: errorFor('email') })}
          />
        </Field>
        <Field id={`${idp}-phone`} label={ot('zelle.phone_label')} hint={ot('zelle.phone_hint')} error={phoneError} extra={phoneLine}>
          <Input
            id={`${idp}-phone`}
            type="tel"
            inputMode="tel"
            value={draft.phone}
            onChange={(e) => update('phone', e.target.value)}
            className="font-mono"
            {...fieldAria(`${idp}-phone`, { hint: true, extra: !!phoneLine, error: phoneError })}
          />
        </Field>
        <Field id={`${idp}-holder`} label={ot('zelle.holder_label')} error={errorFor('holder_name')}>
          <Input
            id={`${idp}-holder`}
            value={draft.holder_name}
            onChange={(e) => update('holder_name', e.target.value)}
            {...fieldAria(`${idp}-holder`, { error: errorFor('holder_name') })}
          />
        </Field>
      </div>
    </>
  )
}

function BinanceFields({ idp, ot, draft, update, errorFor }: FieldsProps) {
  // An address that does not look like its network's: lost money if she
  // saved it, so it shows as she types (the API refuses it too).
  const address = draft.usdt_address.replace(/\s/g, '')
  const network = draft.usdt_network.trim()
  const addressError = errorFor('usdt_address')
  const mismatch = !!address && !!network && /^[A-Za-z0-9]+$/.test(address) && !addressMatchesNetwork(address, network)
  const addressLine =
    !addressError && mismatch ? (
      <p id={`${idp}-address-extra`} className="text-xs font-medium text-red-600">
        {ot('method_errors.address_network', { network: networkLabel(network) })}
      </p>
    ) : null
  const networkError = errorFor('usdt_network')
  return (
    <>
      <legend className="mb-1 text-sm font-semibold text-[#190933]">{ot('binance.section_account')}</legend>
      <p className="text-xs text-[#584F72]">{ot('binance.either_hint')}</p>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Field id={`${idp}-pay-id`} label={ot('binance.pay_id_label')} hint={ot('binance.pay_id_hint')} error={errorFor('pay_id')}>
          <Input
            id={`${idp}-pay-id`}
            inputMode="numeric"
            value={draft.pay_id}
            onChange={(e) => update('pay_id', e.target.value)}
            className="font-mono"
            {...fieldAria(`${idp}-pay-id`, { hint: true, error: errorFor('pay_id') })}
          />
        </Field>
        <div className="hidden md:block" aria-hidden />
        <Field id={`${idp}-address`} label={ot('binance.address_label')} hint={ot('binance.address_hint')} error={addressError} extra={addressLine}>
          <Input
            id={`${idp}-address`}
            value={draft.usdt_address}
            autoCapitalize="none"
            spellCheck={false}
            onChange={(e) => update('usdt_address', e.target.value)}
            className="font-mono"
            {...fieldAria(`${idp}-address`, { hint: true, extra: !!addressLine, error: addressError, invalid: mismatch })}
          />
        </Field>
        <Field id={`${idp}-network`} label={ot('binance.network_label')} hint={ot('binance.network_hint')} error={networkError}>
          <select
            id={`${idp}-network`}
            value={network}
            onChange={(e) => update('usdt_network', e.target.value)}
            className={`${SELECT_CLASS} ${network === '' ? 'text-muted-foreground' : ''}`}
            {...fieldAria(`${idp}-network`, { hint: true, error: networkError })}
          >
            <option value="">{ot('binance.network_choose')}</option>
            {USDT_NETWORKS.map((code) => (
              <option key={code} value={code}>
                {networkLabel(code)}
              </option>
            ))}
          </select>
        </Field>
      </div>
    </>
  )
}

/** What is saved, while the form is closed. */
function summaryRows(method: ExtraMethod, state: ManualMethodState, ot: OrdersTranslate): SavedRow[] {
  const s = state.settings ?? {}
  const dash = (value: string | undefined) => value || '—'
  const rows: SavedRow[] =
    method === 'transferencia'
      ? [
          { label: ot('detail.bank'), value: dash(bankText(s.bank_name, s.bank_code)) },
          { label: ot('detail.account_number'), value: dash(s.account_number ? formatAccountNumber(s.account_number) : ''), mono: true },
          { label: ot('detail.account_type'), value: dash(s.account_type ? accountTypeLabel(ot, s.account_type) : '') },
          { label: ot('detail.holder'), value: dash(s.holder_name) },
          { label: ot('detail.id_document'), value: dash(s.id_document), mono: true },
        ]
      : method === 'zelle'
        ? [
            { label: ot('detail.zelle_email'), value: dash(s.email) },
            { label: ot('detail.zelle_phone'), value: dash(s.phone), mono: true },
            { label: ot('detail.holder'), value: dash(s.holder_name) },
          ]
        : [
            { label: ot('detail.pay_id'), value: dash(s.pay_id), mono: true },
            { label: ot('detail.usdt_network'), value: dash(s.usdt_network ? networkLabel(s.usdt_network) : '') },
            { label: ot('detail.usdt_address'), value: dash(s.usdt_address), mono: true, wide: true },
          ]
  if (s.instructions) rows.push({ label: ot('detail.instructions'), value: s.instructions, wide: true })
  return rows
}
