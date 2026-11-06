'use client'
// Sanar y Criar: pieces shared by the cards of "Pagos manuales" in Pagos ›
// Configuración (ManualSettingsCard, PagoMovilCard, ManualMethodCard), so the
// four look and behave the same: the header row (icon, title, status chip,
// tagline, notes, edit button and switch), one field with its label, hint,
// live line and error, the error banner, the form footer, the saved summary,
// the bank picker, the "Falta: …" text and what to refresh after a save.
import React from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, CheckCircle2, CircleOff, Loader2, Pencil } from 'lucide-react'
import { Button } from '@components/ui/button'
import { Input } from '@components/ui/input'
import { Label } from '@components/ui/label'
import { Switch } from '@components/ui/switch'
import { queryKeys } from '@/lib/query/keys'
import { ORDER_LIMITS, OTHER_BANK, VE_BANKS, splitMissing } from '../Orders/ordersForm'
import { OrdersTranslate, missingLabel } from '../Orders/useOrdersT'

export const SELECT_CLASS =
  'flex h-9 w-full rounded-lg border border-input bg-card px-3 py-1 text-sm shadow-xs focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50'

/** aria-* that tie a control to its label, hint, live line and error. */
export function fieldAria(id: string, opts: { hint?: boolean; extra?: boolean; error?: string | null; invalid?: boolean }) {
  const describedBy = [opts.hint ? `${id}-hint` : null, opts.extra ? `${id}-extra` : null, opts.error ? `${id}-error` : null]
    .filter(Boolean)
    .join(' ')
  return {
    'aria-labelledby': `${id}-label`,
    'aria-describedby': describedBy || undefined,
    'aria-invalid': opts.error || opts.invalid ? true : undefined,
  }
}

/**
 * Label, control, hint, live line and error of one field. Ids: `${id}-label`,
 * `${id}-hint`, `${id}-extra` (the `extra` element sets its own) and
 * `${id}-error`; fieldAria() ties the control to them.
 */
export function Field({
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

/** Incompleto / Activo / Desactivado, from the method's `active` (complete) and `enabled` (its switch). */
export function CardStatusChip({ active, enabled, ot }: { active: boolean; enabled: boolean; ot: OrdersTranslate }) {
  if (!active) {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-amber-800 bg-amber-100 px-2 py-0.5 rounded-full">
        <AlertTriangle size={10} aria-hidden />
        <span>{ot('manual_card.chip_incomplete')}</span>
      </span>
    )
  }
  if (enabled) {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-green-700 bg-green-100 px-2 py-0.5 rounded-full">
        <CheckCircle2 size={10} aria-hidden />
        <span>{ot('manual_card.chip_active')}</span>
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-1 text-xs text-gray-600 bg-gray-100 px-2 py-0.5 rounded-full">
      <CircleOff size={10} aria-hidden />
      <span>{ot('manual_card.chip_disabled')}</span>
    </span>
  )
}

/** The 40 px icon badge of a card. */
export function CardIcon({ children }: { children: React.ReactNode }) {
  return <div className="flex items-center justify-center w-10 h-10 bg-[#EEEDFF] rounded-lg shrink-0 text-[#6559CA]">{children}</div>
}

/** Shown while the card's data loads. */
export function CardSkeleton() {
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

/** The card's title with why it could not load. */
export function CardLoadError({ icon, title, message }: { icon: React.ReactNode; title: string; message: string }) {
  return (
    <div className="border border-[#EAE8F2] rounded-xl px-5 py-4 flex items-center gap-4">
      <CardIcon>{icon}</CardIcon>
      <div className="min-w-0">
        <h3 className="font-semibold text-[#190933]">{title}</h3>
        <p className="text-sm text-red-600">{message}</p>
      </div>
    </div>
  )
}

/**
 * The main row of a card: icon, title, chip, tagline and notes on the left;
 * the edit button and the switch on the right (below the text on phones).
 */
export function CardHeader({
  icon,
  title,
  chip,
  tagline,
  notes,
  actions,
}: {
  icon: React.ReactNode
  title: string
  chip?: React.ReactNode
  tagline: string
  notes?: React.ReactNode
  actions?: React.ReactNode
}) {
  return (
    <div className="flex flex-wrap gap-3 items-center justify-between px-5 py-4 bg-white">
      {/* flex-1 + basis: the text shrinks so the actions stay beside it on
          wide screens and only wrap below it on phones. */}
      <div className="flex items-center gap-4 min-w-0 flex-1 basis-64">
        <CardIcon>{icon}</CardIcon>
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="font-semibold text-[#190933]">{title}</h3>
            {chip}
          </div>
          <p className="text-sm text-gray-500 mt-0.5">{tagline}</p>
          {notes}
        </div>
      </div>
      {actions && <div className="flex flex-wrap items-center gap-3 shrink-0 max-w-full">{actions}</div>}
    </div>
  )
}

/** "Editar datos" (or "Configurar") on the header row. */
export function EditButton({ label, disabled, onClick }: { label: string; disabled: boolean; onClick: () => void }) {
  return (
    <Button type="button" variant="outline" size="sm" className="min-h-11 text-xs rounded-full sm:min-h-8" disabled={disabled} onClick={onClick}>
      <Pencil size={12} className="me-1" aria-hidden />
      {label}
    </Button>
  )
}

/** A method's switch with its label; the label is part of the target (at least 44 px tall on phones). */
export function CardSwitch({
  id,
  label,
  checked,
  busy,
  disabled,
  onChange,
}: {
  id: string
  label: string
  checked: boolean
  busy: boolean
  disabled: boolean
  onChange: (_checked: boolean) => void
}) {
  return (
    <div className="flex min-h-11 items-center gap-2 rounded-full border border-[#EAE8F2] bg-[#FFFCF9] py-1 ps-3 pe-1.5 sm:min-h-0">
      <Label htmlFor={id} id={`${id}-label`} className="cursor-pointer text-sm text-[#190933]">
        {label}
      </Label>
      {busy && <Loader2 size={14} className="animate-spin text-gray-400" aria-hidden />}
      <Switch
        id={id}
        aria-labelledby={`${id}-label`}
        checked={checked}
        disabled={disabled}
        onCheckedChange={(value) => onChange(value === true)}
        className="data-[state=checked]:bg-[#7D75E2]"
      />
    </div>
  )
}

/** The banner under the header row: why a save did not go through. */
export function CardFormError({ message }: { message: string | null }) {
  if (!message) return null
  return (
    <div role="alert" className="bg-amber-50 border-t border-amber-100 px-5 py-2.5 text-sm text-amber-900 flex items-start gap-2">
      <AlertTriangle size={14} className="shrink-0 mt-0.5" aria-hidden />
      <span>{message}</span>
    </div>
  )
}

/** "Tienes cambios sin guardar." and Cancel / Save at the bottom of a form. */
export function FormFooter({
  ot,
  dirty,
  canCancel,
  saving,
  onCancel,
}: {
  ot: OrdersTranslate
  dirty: boolean
  canCancel: boolean
  saving: boolean
  onCancel: () => void
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <p role="status" className="text-sm text-amber-700 min-h-5">
        {dirty ? ot('manual_card.unsaved') : ''}
      </p>
      <div className="flex flex-wrap gap-2">
        {canCancel && (
          <Button type="button" variant="outline" className="min-h-11 rounded-full sm:min-h-9" onClick={onCancel}>
            {ot('manual_card.cancel')}
          </Button>
        )}
        <Button
          type="submit"
          className="min-h-11 rounded-full bg-[#190933] text-white hover:bg-[#41375B] sm:min-h-9"
          aria-busy={saving || undefined}
        >
          {saving && <Loader2 size={14} className="animate-spin" aria-hidden />}
          {saving ? ot('manual_card.saving') : ot('manual_card.save')}
        </Button>
      </div>
    </div>
  )
}

export type SavedRow = { label: string; value: string; mono?: boolean; wide?: boolean }

/** What is saved, while the form is closed. */
export function SavedSummary({ rows }: { rows: SavedRow[] }) {
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

/**
 * The names of the missing data: the card's own first, then the shared ones
 * with where they are set ("banco, titular, WhatsApp (en Ajustes de los
 * pagos manuales)").
 */
export function missingText(ot: OrdersTranslate, missing: readonly string[] | null | undefined): string {
  const { own, common } = splitMissing(missing)
  const parts = own.map((token) => missingLabel(ot, token))
  if (common.length) {
    parts.push(ot('manual_card.missing_common', { fields: common.map((token) => missingLabel(ot, token)).join(', ') }))
  }
  return parts.join(', ')
}

/** "Falta: …" under the tagline (nothing when nothing is missing). */
export function MissingLine({ missing, ot }: { missing: readonly string[] | null | undefined; ot: OrdersTranslate }) {
  const text = missingText(ot, missing)
  if (!text) return null
  return <p className="text-xs text-amber-700 mt-1">{ot('manual_card.missing', { fields: text })}</p>
}

/**
 * What every card refreshes after a save: both settings queries (a shared
 * setting changes what the methods miss), the payment configs, and the
 * store's methods and cart (the cart offers a method only while it is on and
 * complete).
 */
export function useRefreshManual(): (_orgId: number) => void {
  const queryClient = useQueryClient()
  return (orgId: number) => {
    queryClient.invalidateQueries({ queryKey: queryKeys.orders.manualSettings(orgId) })
    queryClient.invalidateQueries({ queryKey: queryKeys.orders.manualMethods(orgId) })
    queryClient.invalidateQueries({ queryKey: queryKeys.payments.configs(orgId) })
    queryClient.invalidateQueries({ queryKey: ['payments', orgId, 'checkout-providers'] })
    queryClient.invalidateQueries({ queryKey: ['payments', orgId, 'cart'] })
  }
}

/**
 * The bank: the Venezuelan banks plus "Otro banco", which asks for its name
 * and code. Goes inside the form's two-column grid (the "Otro banco" row
 * takes both columns).
 */
export function BankFields({
  idp,
  ot,
  name,
  code,
  choice,
  onPick,
  onName,
  onCode,
  nameError,
  codeError,
  codeHint,
}: {
  /** Prefix of the ids ("pm", "tr"). */
  idp: string
  ot: OrdersTranslate
  name: string
  code: string
  /** A listed code, OTHER_BANK or "" (nothing yet). */
  choice: string
  onPick: (_value: string) => void
  onName: (_value: string) => void
  onCode: (_value: string) => void
  nameError: string | null
  codeError: string | null
  codeHint: string
}) {
  const other = choice === OTHER_BANK
  // With a listed bank, its name and code are not on screen: their error goes under the picker.
  const pickerError = other ? null : nameError ?? codeError
  return (
    <>
      <Field id={`${idp}-bank`} label={ot('bank.label')} error={pickerError}>
        <select
          id={`${idp}-bank`}
          value={choice}
          onChange={(e) => onPick(e.target.value)}
          className={`${SELECT_CLASS} ${choice === '' ? 'text-muted-foreground' : ''}`}
          {...fieldAria(`${idp}-bank`, { error: pickerError })}
        >
          <option value="" disabled>
            {ot('bank.choose')}
          </option>
          {VE_BANKS.map((bank) => (
            <option key={bank.code} value={bank.code}>
              {bank.code} · {bank.name}
            </option>
          ))}
          <option value={OTHER_BANK}>{ot('bank.other')}</option>
        </select>
      </Field>
      {other && (
        <div className="grid grid-cols-[minmax(0,1fr)_8rem] gap-3 md:col-span-2">
          <Field id={`${idp}-bank-name`} label={ot('bank.name_label')} error={nameError}>
            <Input
              id={`${idp}-bank-name`}
              value={name}
              maxLength={ORDER_LIMITS.bank_name + 20}
              onChange={(e) => onName(e.target.value)}
              {...fieldAria(`${idp}-bank-name`, { error: nameError })}
            />
          </Field>
          <Field id={`${idp}-bank-code`} label={ot('bank.code_label')} hint={codeHint} error={codeError}>
            <Input
              id={`${idp}-bank-code`}
              value={code}
              inputMode="numeric"
              maxLength={4}
              onChange={(e) => onCode(e.target.value.replace(/\D/g, '').slice(0, 4))}
              className="font-mono"
              {...fieldAria(`${idp}-bank-code`, { hint: true, error: codeError })}
            />
          </Field>
        </div>
      )}
    </>
  )
}
