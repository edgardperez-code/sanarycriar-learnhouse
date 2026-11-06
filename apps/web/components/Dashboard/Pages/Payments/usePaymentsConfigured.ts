'use client'
// Sanar y Criar: whether the org has some way to get paid, for the pages of
// Pagos that otherwise show "Aún no hay un método de cobro" (offers, groups,
// sales). usePaymentsEnabled reads the configs' `active` column: right for
// PayPal, but the manual row's columns are Pago Móvil's only, so a complete
// bank transfer, Zelle or Binance (GET /manual/methods) counts here too.
import { usePaymentsEnabled } from '@hooks/usePaymentsEnabled'
import { EXTRA_METHODS } from '../Orders/ordersForm'
import { useManualMethods } from '../Orders/useOrdersApi'

export function usePaymentsConfigured() {
  const providers = usePaymentsEnabled()
  const methods = useManualMethods()
  const manualComplete = EXTRA_METHODS.some((method) => !!methods.data?.[method]?.active)
  const isEnabled = providers.isEnabled || manualComplete
  return {
    isEnabled,
    // Waits for both answers unless one of them already says yes.
    isLoading: !isEnabled && (providers.isLoading || methods.isPending),
    error: providers.error,
  }
}

export default usePaymentsConfigured
