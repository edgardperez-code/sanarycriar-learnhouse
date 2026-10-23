// hooks/usePaymentsEnabled.ts
import { useOrg } from '@components/Contexts/OrgContext';
import { useLHSession } from '@components/Contexts/LHSessionContext';
import { useQuery } from '@tanstack/react-query';
import { queryKeys } from '@/lib/query/keys';
import { getPaymentConfigs } from '@services/payments/payments';

export function usePaymentsEnabled() {
  const org = useOrg() as any;
  const session = useLHSession() as any;
  const access_token = session?.data?.tokens?.access_token;

  const { data: paymentConfigs, error, isLoading } = useQuery({
    queryKey: queryKeys.payments.configs(org?.id),
    queryFn: () => getPaymentConfigs(org.id, access_token),
    enabled: !!org && !!access_token,
    staleTime: 60_000,
  });

  // True if any payment provider is active, not tied to a specific provider
  // Sanar y Criar: tolerate a non-array body.
  const isAnyProviderActive = Array.isArray(paymentConfigs) && paymentConfigs.some((config: any) => config?.active);

  return {
    isEnabled: !!isAnyProviderActive,
    // Sanar y Criar: the query waits for the session; don't flash the
    // 'not configured' state meanwhile.
    isLoading: isLoading || session?.status === 'loading',
    error
  };
}