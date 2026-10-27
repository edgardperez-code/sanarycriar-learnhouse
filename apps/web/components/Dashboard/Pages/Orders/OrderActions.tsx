'use client'
// Sanar y Criar: what the admin can do with one order (contract §C.4):
// pending -> "Marcar como pagado" / "Rechazar"; expired, rejected, cancelled
// -> "Marcar como pagado" behind an extra warning; paid -> "Anular"; voided ->
// nothing. The buttons sit in the detail's footer; each one swaps the detail
// for its small form (better on a phone than a form inside a footer).
//
// Before sending, every form reads the order again: if its state moved since
// the form opened (the buyer cancelled, it expired, someone else confirmed
// it) nothing is sent and the detail says so. A 409 or a server error
// refreshes the order lists. Buttons stay disabled while a request runs and
// the API's message shows in the form.
import React, { useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, Ban, CheckCircle2, Loader2, RefreshCw, ShieldAlert, XCircle } from 'lucide-react'
import toast from 'react-hot-toast'
import { Button } from '@components/ui/button'
import { Input } from '@components/ui/input'
import { Label } from '@components/ui/label'
import { Textarea } from '@components/ui/textarea'
import { Checkbox } from '@components/ui/checkbox'
import { useScT } from '@components/Payments/useScT'
import { describePaymentError, errorCode } from '@components/Payments/commerce'
import { confirmPurchase, getPurchaseAdmin, rejectPurchase, voidPurchase } from '@services/payments/orders'
import {
  ORDER_LIMITS,
  PurchaseAdmin,
  canConfirm,
  canReject,
  canVoid,
  errorList,
  formatAmount,
  isValidNote,
  isValidReason,
  isValidReference,
  needsLateWarning,
  normalizeReference,
  textLength,
} from './ordersForm'
import { BoldText } from './OrderBits'
import { useOrdersAuth } from './useOrdersApi'
import { OrdersTranslate, ordersLabel, useOrdersT } from './useOrdersT'

export type OrderAction = 'confirm' | 'reject' | 'void'

export type OrderActionExtra = {
  /** The rejection e-mail went out (she asked for it and the order did change). */
  notified?: boolean
  /** The order was already paid with another reference: nothing changed. */
  otherReference?: string | null
}

/** Called with the updated order the API returned. */
export type OrderActionDone = (_updated: PurchaseAdmin, _action: OrderAction, _extra: OrderActionExtra) => void

/** The order moved under her: its fresh copy, or null when it no longer exists. */
export type OrderChanged = (_fresh: PurchaseAdmin | null) => void

const PRIMARY = 'bg-[#190933] text-white hover:bg-[#41375B]'
const DANGER_OUTLINE = 'border-red-200 bg-white text-red-700 hover:bg-red-50 hover:text-red-800'

/** True when the order's state still allows that action. */
export function actionAllowed(action: OrderAction, status: string): boolean {
  if (action === 'confirm') return canConfirm(status)
  if (action === 'reject') return canReject(status)
  return canVoid(status)
}

/** "a-hint a-error" for aria-describedby (undefined when empty). */
function describedBy(...ids: Array<string | false | null | undefined>): string | undefined {
  const value = ids.filter(Boolean).join(' ')
  return value || undefined
}

/**
 * Shared by the forms: re-reads the order before an action and refreshes the
 * lists after a conflict or a server error.
 */
function useActionGuard(purchase: PurchaseAdmin, onChanged: OrderChanged) {
  const queryClient = useQueryClient()
  const { orgId, accessToken } = useOrdersAuth()
  // The state she saw when she opened the form.
  const openedStatus = useRef(purchase.status)

  /** The current state when it is still the one she saw; null (and onChanged) otherwise. */
  const currentStatus = async (): Promise<string | null> => {
    const res = await getPurchaseAdmin(orgId, purchase.purchase_uuid, accessToken as string)
    if (res.success && typeof res.data?.status === 'string') {
      if (res.data.status !== openedStatus.current) {
        onChanged(res.data as PurchaseAdmin)
        return null
      }
      return res.data.status
    }
    if (res.status === 404) {
      onChanged(null)
      return null
    }
    // Could not check: the API validates the action anyway.
    return openedStatus.current
  }

  const afterFailure = (status: number) => {
    if (status === 409 || status >= 500) queryClient.invalidateQueries({ queryKey: ['payments', orgId, 'orders'] })
  }

  return { orgId, accessToken, currentStatus, afterFailure }
}

/** The footer of the detail: the actions this state allows (or a short note). */
export function OrderActionButtons({ purchase, onPick }: { purchase: PurchaseAdmin; onPick: (_action: OrderAction) => void }) {
  const { ot } = useOrdersT()
  const status = purchase.status

  if (!canConfirm(status) && !canVoid(status)) {
    return <p className="text-sm text-gray-500">{ot('actions.none')}</p>
  }

  return (
    <div className="space-y-3">
      {needsLateWarning(status) && (
        <p className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          <AlertTriangle size={16} className="mt-0.5 shrink-0" aria-hidden />
          <span>{ordersLabel(ot, 'late_warning', status)}</span>
        </p>
      )}
      <div className="flex flex-wrap items-center justify-end gap-2">
        {canReject(status) && (
          <Button type="button" variant="outline" className={DANGER_OUTLINE} onClick={() => onPick('reject')}>
            <XCircle aria-hidden />
            {ot('actions.reject')}
          </Button>
        )}
        {canVoid(status) && (
          <Button type="button" variant="outline" className={DANGER_OUTLINE} onClick={() => onPick('void')}>
            <Ban aria-hidden />
            {ot('actions.void')}
          </Button>
        )}
        {canConfirm(status) && (
          <Button type="button" className={PRIMARY} onClick={() => onPick('confirm')}>
            <CheckCircle2 aria-hidden />
            {ot('actions.mark_paid')}
          </Button>
        )}
      </div>
    </div>
  )
}

/** The form of one action, shown in place of the detail. */
export function OrderActionForm({
  purchase,
  action,
  onBack,
  onDone,
  onChanged,
}: {
  purchase: PurchaseAdmin
  action: OrderAction
  onBack: () => void
  onDone: OrderActionDone
  onChanged: OrderChanged
}) {
  const { ot } = useOrdersT()
  const props = { purchase, ot, onBack, onDone, onChanged }
  if (action === 'confirm') return <ConfirmForm {...props} />
  if (action === 'reject') return <RejectForm {...props} />
  return <VoidForm {...props} />
}

/**
 * "El pago está confirmado pero falta dar acceso a algún producto": confirms
 * again with the stored reference, which only retries the missing access.
 */
export function FulfillmentRetry({ purchase, onUpdated }: { purchase: PurchaseAdmin; onUpdated: (_updated: PurchaseAdmin) => void }) {
  const { ot } = useOrdersT()
  const { sc } = useScT()
  const queryClient = useQueryClient()
  const { orgId, accessToken } = useOrdersAuth()
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const reference = purchase.bank_reference

  const retry = async () => {
    if (!reference || sending || !accessToken) return
    setSending(true)
    setError(null)
    try {
      const res = await confirmPurchase(
        orgId,
        purchase.purchase_uuid,
        // Its own reference: a reused one was already accepted for this order.
        { bank_reference: reference, allow_reused_reference: true },
        accessToken
      )
      if (!res.success) {
        if (res.status === 409 || res.status >= 500) queryClient.invalidateQueries({ queryKey: ['payments', orgId, 'orders'] })
        setError(describePaymentError(res.data, sc))
        return
      }
      const updated = res.data as PurchaseAdmin
      onUpdated(updated)
      if (updated?.needs_fulfillment) setError(ot('fulfillment.still_missing'))
      else toast.success(ot('fulfillment.done'))
    } catch {
      setError(ot('generic_error'))
    } finally {
      setSending(false)
    }
  }

  return (
    <div role="alert" className="space-y-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-3 text-sm text-amber-900">
      <p className="flex items-start gap-2 font-medium">
        <AlertTriangle size={16} className="mt-0.5 shrink-0" aria-hidden />
        <span>{ot('fulfillment.warning')}</span>
      </p>
      {reference && (
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="border-amber-300 bg-white text-amber-900 hover:bg-amber-100"
          onClick={retry}
          disabled={sending}
          aria-busy={sending || undefined}
        >
          {sending ? <Loader2 className="animate-spin" aria-hidden /> : <RefreshCw aria-hidden />}
          {sending ? ot('fulfillment.retrying') : ot('fulfillment.retry')}
        </Button>
      )}
      {error && <p className="text-sm font-medium text-red-700">{error}</p>}
    </div>
  )
}

type FormProps = {
  purchase: PurchaseAdmin
  ot: OrdersTranslate
  onBack: () => void
  onDone: OrderActionDone
  onChanged: OrderChanged
}

function FieldError({ id, children }: { id: string; children: React.ReactNode }) {
  return (
    <p id={id} className="text-xs font-medium text-red-600">
      {children}
    </p>
  )
}

function FormError({ message }: { message: string | null }) {
  if (!message) return null
  return (
    <p role="alert" className="rounded-lg border border-red-100 bg-red-50 px-3 py-2 text-sm text-red-700">
      {message}
    </p>
  )
}

function Counter({ id, value, max, ot }: { id: string; value: string; max: number; ot: OrdersTranslate }) {
  const length = textLength(value.trim())
  return (
    <span id={id} className={`text-xs tabular-nums ${length > max ? 'font-semibold text-red-600' : 'text-gray-400'}`}>
      {ot('char_count', { count: length, max })}
    </span>
  )
}

function FormButtons({
  ot,
  submitting,
  onBack,
  submitLabel,
  submittingLabel,
  danger = false,
}: {
  ot: OrdersTranslate
  submitting: boolean
  onBack: () => void
  submitLabel: string
  submittingLabel: string
  danger?: boolean
}) {
  return (
    <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
      <Button type="button" variant="outline" onClick={onBack} disabled={submitting}>
        {ot('actions.back')}
      </Button>
      <Button
        type="submit"
        variant={danger ? 'destructive' : 'default'}
        className={danger ? undefined : PRIMARY}
        disabled={submitting}
        aria-busy={submitting || undefined}
      >
        {submitting && <Loader2 className="animate-spin" aria-hidden />}
        {submitting ? submittingLabel : submitLabel}
      </Button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Marcar como pagado
// ---------------------------------------------------------------------------

function ConfirmForm({ purchase, ot, onBack, onDone, onChanged }: FormProps) {
  const { sc } = useScT()
  const { orgId, accessToken, currentStatus, afterFailure } = useActionGuard(purchase, onChanged)
  const [reference, setReference] = useState('')
  const [note, setNote] = useState('')
  const [touched, setTouched] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Codes of the paid orders that already carry this reference (REFERENCE_USED).
  const [reusedIn, setReusedIn] = useState<string[] | null>(null)

  const referenceOk = isValidReference(reference)
  const noteOk = isValidNote(note)
  const showReferenceError = touched && !referenceOk

  const send = async (allowReused: boolean) => {
    setTouched(true)
    if (!referenceOk || !noteOk || submitting || !accessToken) return
    setSubmitting(true)
    setError(null)
    try {
      if ((await currentStatus()) === null) return
      const res = await confirmPurchase(
        orgId,
        purchase.purchase_uuid,
        { bank_reference: reference, note, allow_reused_reference: allowReused },
        accessToken
      )
      if (!res.success) {
        afterFailure(res.status)
        if (errorCode(res.data) === 'REFERENCE_USED') {
          setReusedIn(errorList(res.data, 'purchases'))
          return
        }
        setError(describePaymentError(res.data, sc))
        return
      }
      const updated = res.data as PurchaseAdmin
      const stored = normalizeReference(updated?.bank_reference)
      const otherReference = stored && stored !== normalizeReference(reference) ? updated.bank_reference : null
      onDone(updated, 'confirm', { otherReference })
    } catch {
      setError(ot('generic_error'))
    } finally {
      setSubmitting(false)
    }
  }

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    send(false)
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4" noValidate>
      <p className="rounded-xl bg-[#EEEDFF]/70 px-3 py-2.5 text-sm text-[#41375B]">
        <BoldText text={ot('confirm_form.check_bank', { amount: formatAmount(purchase.amount_ves) })} />
      </p>

      {needsLateWarning(purchase.status) && (
        <p className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          <AlertTriangle size={16} className="mt-0.5 shrink-0" aria-hidden />
          <span>{ordersLabel(ot, 'late_warning', purchase.status)}</span>
        </p>
      )}

      <div className="space-y-1.5">
        <Label htmlFor="order-reference" id="order-reference-label" className="text-[#190933]">
          {ot('confirm_form.reference_label')}
        </Label>
        <Input
          id="order-reference"
          value={reference}
          onChange={(e) => {
            setReference(e.target.value)
            setReusedIn(null)
            setError(null)
          }}
          onBlur={() => setTouched(true)}
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          autoFocus
          maxLength={60}
          aria-labelledby="order-reference-label"
          aria-invalid={showReferenceError ? true : undefined}
          aria-describedby={describedBy('order-reference-hint', showReferenceError && 'order-reference-error')}
          className={`font-mono uppercase ${showReferenceError ? 'border-red-400 focus-visible:ring-red-400' : ''}`}
        />
        <p id="order-reference-hint" className="text-xs text-gray-500">
          {ot('confirm_form.reference_hint')}
        </p>
        {showReferenceError && <FieldError id="order-reference-error">{ot('confirm_form.reference_invalid')}</FieldError>}
      </div>

      <div className="space-y-1.5">
        <div className="flex items-baseline justify-between gap-3">
          <Label htmlFor="order-note" id="order-note-label" className="text-[#190933]">
            {ot('confirm_form.note_label')}
          </Label>
          <Counter id="order-note-count" value={note} max={ORDER_LIMITS.note} ot={ot} />
        </div>
        <Textarea
          id="order-note"
          rows={2}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          aria-labelledby="order-note-label"
          aria-invalid={!noteOk ? true : undefined}
          aria-describedby={describedBy('order-note-hint', !noteOk && 'order-note-error', 'order-note-count')}
          className={!noteOk ? 'border-red-400 focus-visible:ring-red-400' : undefined}
        />
        <p id="order-note-hint" className="text-xs text-gray-500">
          {ot('confirm_form.note_hint')}
        </p>
        {!noteOk && <FieldError id="order-note-error">{ot('confirm_form.note_too_long', { max: ORDER_LIMITS.note })}</FieldError>}
      </div>

      {reusedIn && (
        <div role="alert" className="space-y-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-3 text-sm text-amber-900">
          <p className="flex items-start gap-2 font-semibold">
            <ShieldAlert size={16} className="mt-0.5 shrink-0" aria-hidden />
            {ot('confirm_form.reused_title')}
          </p>
          <p>{ot('confirm_form.reused_body', { codes: reusedIn.length ? reusedIn.join(', ') : '—' })}</p>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="border-amber-300 bg-white text-amber-900 hover:bg-amber-100"
            onClick={() => send(true)}
            disabled={submitting}
          >
            {submitting && <Loader2 className="animate-spin" aria-hidden />}
            {ot('confirm_form.force')}
          </Button>
        </div>
      )}

      <FormError message={error} />
      <FormButtons
        ot={ot}
        submitting={submitting}
        onBack={onBack}
        submitLabel={ot('confirm_form.submit')}
        submittingLabel={ot('confirm_form.submitting')}
      />
    </form>
  )
}

// ---------------------------------------------------------------------------
// Rechazar
// ---------------------------------------------------------------------------

function RejectForm({ purchase, ot, onBack, onDone, onChanged }: FormProps) {
  const { sc } = useScT()
  const { orgId, accessToken, currentStatus, afterFailure } = useActionGuard(purchase, onChanged)
  const [reason, setReason] = useState('')
  const [notify, setNotify] = useState(true)
  const [touched, setTouched] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const reasonOk = isValidReason(reason)

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setTouched(true)
    if (!reasonOk || submitting || !accessToken) return
    setSubmitting(true)
    setError(null)
    try {
      const before = await currentStatus()
      if (before === null) return
      const res = await rejectPurchase(orgId, purchase.purchase_uuid, { reason, notify }, accessToken)
      if (!res.success) {
        afterFailure(res.status)
        setError(describePaymentError(res.data, sc))
        return
      }
      const updated = res.data as PurchaseAdmin
      // The e-mail only goes out when this request is the one that rejected it.
      const notified = notify && before !== 'rejected' && updated?.status === 'rejected'
      onDone(updated, 'reject', { notified })
    } catch {
      setError(ot('generic_error'))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4" noValidate>
      <p className="text-sm text-gray-600">{ot('reject_form.intro')}</p>
      <ReasonField
        id="order-reject-reason"
        ot={ot}
        label={ot('reject_form.reason_label')}
        hint={ot('reject_form.reason_hint')}
        invalidText={ot('reject_form.reason_invalid')}
        value={reason}
        onChange={setReason}
        showError={touched && !reasonOk}
        onBlur={() => setTouched(true)}
      />
      <div className="flex items-center gap-2">
        <Checkbox
          id="order-reject-notify"
          checked={notify}
          onCheckedChange={(checked) => setNotify(checked === true)}
          aria-labelledby="order-reject-notify-label"
        />
        <Label htmlFor="order-reject-notify" id="order-reject-notify-label" className="cursor-pointer text-sm font-normal text-[#190933]">
          {ot('reject_form.notify_label')}
        </Label>
      </div>
      <FormError message={error} />
      <FormButtons
        ot={ot}
        danger
        submitting={submitting}
        onBack={onBack}
        submitLabel={ot('reject_form.submit')}
        submittingLabel={ot('reject_form.submitting')}
      />
    </form>
  )
}

// ---------------------------------------------------------------------------
// Anular
// ---------------------------------------------------------------------------

function VoidForm({ purchase, ot, onBack, onDone, onChanged }: FormProps) {
  const { sc } = useScT()
  const { orgId, accessToken, currentStatus, afterFailure } = useActionGuard(purchase, onChanged)
  const [reason, setReason] = useState('')
  const [touched, setTouched] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const reasonOk = isValidReason(reason)

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setTouched(true)
    if (!reasonOk || submitting || !accessToken) return
    setSubmitting(true)
    setError(null)
    try {
      if ((await currentStatus()) === null) return
      const res = await voidPurchase(orgId, purchase.purchase_uuid, { reason }, accessToken)
      if (!res.success) {
        afterFailure(res.status)
        setError(describePaymentError(res.data, sc))
        return
      }
      onDone(res.data as PurchaseAdmin, 'void', {})
    } catch {
      setError(ot('generic_error'))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4" noValidate>
      <p role="note" className="flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-3 py-2.5 text-sm font-medium text-red-700">
        <AlertTriangle size={16} className="mt-0.5 shrink-0" aria-hidden />
        <span>{ot('void_form.warning')}</span>
      </p>
      <p className="text-sm text-gray-600">{ot('void_form.intro')}</p>
      <ReasonField
        id="order-void-reason"
        ot={ot}
        label={ot('void_form.reason_label')}
        hint={ot('void_form.reason_hint')}
        invalidText={ot('void_form.reason_invalid')}
        value={reason}
        onChange={setReason}
        showError={touched && !reasonOk}
        onBlur={() => setTouched(true)}
      />
      <FormError message={error} />
      <FormButtons
        ot={ot}
        danger
        submitting={submitting}
        onBack={onBack}
        submitLabel={ot('void_form.submit')}
        submittingLabel={ot('void_form.submitting')}
      />
    </form>
  )
}

function ReasonField({
  id,
  ot,
  label,
  hint,
  invalidText,
  value,
  onChange,
  showError,
  onBlur,
}: {
  id: string
  ot: OrdersTranslate
  label: string
  hint?: string
  invalidText: string
  value: string
  onChange: (_value: string) => void
  showError: boolean
  onBlur: () => void
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-3">
        <Label htmlFor={id} id={`${id}-label`} className="text-[#190933]">
          {label}
        </Label>
        <Counter id={`${id}-count`} value={value} max={ORDER_LIMITS.reason_max} ot={ot} />
      </div>
      <Textarea
        id={id}
        rows={3}
        value={value}
        autoFocus
        onChange={(e) => onChange(e.target.value)}
        onBlur={onBlur}
        aria-labelledby={`${id}-label`}
        aria-invalid={showError ? true : undefined}
        aria-describedby={describedBy(hint && `${id}-hint`, showError && `${id}-error`, `${id}-count`)}
        className={showError ? 'border-red-400 focus-visible:ring-red-400' : undefined}
      />
      {hint && (
        <p id={`${id}-hint`} className="text-xs text-gray-500">
          {hint}
        </p>
      )}
      {showError && <FieldError id={`${id}-error`}>{invalidText}</FieldError>}
    </div>
  )
}
