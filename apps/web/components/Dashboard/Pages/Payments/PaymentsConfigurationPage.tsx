'use client';
// Sanar y Criar: payment provider configuration. PayPal is configured with a
// credentials form (Client ID + Secret + environment + webhook id) instead of
// the upstream Stripe Connect OAuth popup; Pago Móvil (manual, confirmed in
// Pedidos) has its own card, PagoMovilCard. The stored secret is never shown
// or sent back to the browser.
import React, { useMemo, useState } from 'react';
import { useOrg } from '@components/Contexts/OrgContext';
import { useLHSession } from '@components/Contexts/LHSessionContext';
import { getPaymentConfigs, removePaymentConfig } from '@services/payments/payments';
import { createPaypalConfig, updatePaypalConfig, PaypalEnvironment } from '@services/payments/providers/paypal';
import { getAPIUrl } from '@services/config/config';
import {
  AlertTriangle,
  CheckCircle2,
  Copy,
  ExternalLink,
  KeyRound,
  Loader2,
  Pencil,
  Plug,
  Trash2,
  XCircle,
} from 'lucide-react';
import toast from 'react-hot-toast';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { queryKeys } from '@/lib/query/keys';
import ConfirmationModal from '@components/Objects/StyledElements/ConfirmationModal/ConfirmationModal';
import { Button } from '@components/ui/button';
import { Input } from '@components/ui/input';
import { Label } from '@components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@components/ui/select';
import { useLHAnalytics, AnalyticsEvent } from '@services/analytics';
import { SiPaypal } from '@icons-pack/react-simple-icons';
import { useScT, ScTranslate } from '@components/Payments/useScT';
import { describePaymentError } from '@components/Payments/commerce';
import PagoMovilCard from './PagoMovilCard';

const PAYPAL_DEVELOPER_URL = 'https://developer.paypal.com/dashboard/applications';

const PAYPAL_WEBHOOK_EVENTS = [
  'CHECKOUT.ORDER.APPROVED',
  'PAYMENT.CAPTURE.COMPLETED',
  'PAYMENT.CAPTURE.PENDING',
  'PAYMENT.CAPTURE.DECLINED',
  'PAYMENT.CAPTURE.DENIED',
  'PAYMENT.CAPTURE.REFUNDED',
  'PAYMENT.CAPTURE.REVERSED',
];

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------
const PaymentsConfigurationPage: React.FC = () => {
  const org = useOrg() as any;
  const session = useLHSession() as any;
  const access_token = session?.data?.tokens?.access_token;
  const { sc } = useScT();

  const { data: paymentConfigs, error, isLoading } = useQuery({
    queryKey: queryKeys.payments.configs(org?.id),
    queryFn: () => getPaymentConfigs(org.id, access_token),
    enabled: !!(org?.id && access_token),
    staleTime: 60_000,
  });

  if (isLoading) return (
    <div className="ms-4 me-4 sm:ms-10 sm:me-10 mx-auto bg-white rounded-xl nice-shadow px-4 py-4 animate-pulse">
      <div className="h-14 bg-gray-100 rounded-md mb-4" />
      <div className="space-y-3">
        {[1, 2].map((i) => (
          <div key={i} className="border border-gray-200 rounded-xl px-5 py-4 flex items-center justify-between">
            <div className="flex items-center space-x-4">
              <div className="w-10 h-10 bg-gray-200 rounded-lg" />
              <div className="space-y-2">
                <div className="h-4 bg-gray-200 rounded w-28" />
                <div className="h-3 bg-gray-100 rounded w-48" />
              </div>
            </div>
            <div className="h-8 bg-gray-200 rounded w-24" />
          </div>
        ))}
      </div>
    </div>
  );
  if (error) return <div className="p-6 text-sm text-red-500">{sc('config.load_error')}</div>;

  const configs: any[] = Array.isArray(paymentConfigs) ? paymentConfigs : [];
  const paypalConfig = configs.find((c: any) => c.provider === 'paypal');

  return (
    <div className="ms-4 me-4 sm:ms-10 sm:me-10 mx-auto bg-white rounded-xl nice-shadow px-4 py-4">
      <div className="flex flex-col bg-[#EEEDFF]/60 -space-y-1 px-5 py-3 rounded-md mb-4">
        <h1 className="font-bold text-xl text-[#190933]">{sc('config.title')}</h1>
        <h2 className="text-[#584F72] text-sm">{sc('config.subtitle')}</h2>
      </div>

      <div className="space-y-3">
        <PaypalCard config={paypalConfig} orgId={org.id} accessToken={access_token} sc={sc} />
        <PagoMovilCard />
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// PayPal
// ---------------------------------------------------------------------------
interface PaypalCardProps {
  config: any | undefined;
  orgId: number;
  accessToken: string;
  sc: ScTranslate;
}

function StatusChip({ config, sc }: { config: any; sc: ScTranslate }) {
  if (!config) {
    return (
      <span className="text-xs text-gray-500 bg-gray-100 px-2 py-0.5 rounded-full">
        {sc('config.status_not_configured')}
      </span>
    );
  }
  if (config.active) {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-green-700 bg-green-100 px-2 py-0.5 rounded-full">
        <CheckCircle2 size={10} />
        <span>{sc('config.status_connected')}</span>
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-xs text-amber-700 bg-amber-100 px-2 py-0.5 rounded-full">
      <XCircle size={10} />
      <span>{sc('config.status_invalid')}</span>
    </span>
  );
}

const PaypalCard: React.FC<PaypalCardProps> = ({ config, orgId, accessToken, sc }) => {
  const queryClient = useQueryClient();
  const { track } = useLHAnalytics('dashboard');
  const [isEditing, setIsEditing] = useState(false);
  const settings = config?.settings ?? {};
  const isConnected = !!config?.active;

  const handleDelete = async () => {
    const res = await removePaymentConfig(orgId, config.id, accessToken);
    if (res.success) {
      toast.success(sc('config.removed'));
      queryClient.invalidateQueries({ queryKey: queryKeys.payments.configs(orgId) });
      setIsEditing(false);
    } else {
      toast.error(describePaymentError(res.data, sc, 'config.remove_error'));
    }
  };

  const openForm = () => {
    track(AnalyticsEvent.PaymentProviderConnectClicked, {
      is_reconnect: isConnected,
      had_existing_config: !!config,
    });
    setIsEditing(true);
  };

  return (
    <div className="border border-[#EAE8F2] rounded-xl overflow-hidden">
      {/* Main row */}
      <div className="flex flex-wrap gap-3 items-center justify-between px-5 py-4 bg-white">
        {/* flex-1 + basis: the text shrinks so the actions stay beside it on
            wide screens and only wrap below it on phones. */}
        <div className="flex items-center space-x-4 min-w-0 flex-1 basis-64">
          <div className="flex items-center justify-center w-10 h-10 bg-[#EEEDFF] rounded-lg shrink-0">
            <SiPaypal size={22} className="text-[#003087]" />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-semibold text-[#190933]">PayPal</span>
              <StatusChip config={config} sc={sc} />
              {config && (
                <span className="text-xs text-[#6559CA] bg-[#EEEDFF] px-2 py-0.5 rounded-full">
                  {settings.environment === 'live' ? sc('config.env_live') : sc('config.env_sandbox')}
                </span>
              )}
            </div>
            <p className="text-sm text-gray-500 mt-0.5">{sc('config.paypal_tagline')}</p>
          </div>
        </div>

        {/* Wraps on phones; otherwise the "Quitar" button is clipped by the card. */}
        <div className="flex flex-wrap items-center gap-2 shrink-0 max-w-full">
          <a
            href={PAYPAL_DEVELOPER_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="text-gray-400 hover:text-gray-600 transition p-1"
            title={sc('config.paypal_developer_link')}
            aria-label={sc('config.paypal_developer_link')}
          >
            <ExternalLink size={15} />
          </a>
          {config ? (
            <>
              {!isEditing && (
                <Button onClick={openForm} variant="outline" size="sm" className="text-xs rounded-full">
                  <Pencil size={12} className="me-1" />
                  {sc('config.edit_credentials')}
                </Button>
              )}
              <ConfirmationModal
                confirmationButtonText={sc('config.remove')}
                confirmationMessage={sc('config.remove_confirm')}
                dialogTitle={sc('config.remove_title')}
                dialogTrigger={
                  <Button variant="destructive" size="sm" className="text-xs rounded-full">
                    <Trash2 size={12} className="me-1" />
                    {sc('config.remove')}
                  </Button>
                }
                functionToExecute={handleDelete}
                status="warning"
              />
            </>
          ) : (
            !isEditing && (
              <Button
                onClick={openForm}
                size="sm"
                className="text-xs rounded-full bg-[#190933] text-white hover:bg-[#41375B]"
              >
                <Plug size={12} className="me-1" />
                {sc('config.connect_paypal')}
              </Button>
            )
          )}
        </div>
      </div>

      {/* Stored settings (never the secret itself) */}
      {config && !isEditing && (
        <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2 px-5 py-3 border-t border-[#EAE8F2] bg-[#FFFCF9] text-xs">
          <div className="min-w-0">
            <dt className="text-gray-400">{sc('config.field_client_id')}</dt>
            <dd className="font-mono text-gray-700 truncate">{settings.client_id || '—'}</dd>
          </div>
          <div>
            <dt className="text-gray-400">{sc('config.field_secret')}</dt>
            <dd className="text-gray-700 flex items-center gap-1">
              <KeyRound size={11} className={settings.has_secret ? 'text-green-600' : 'text-amber-600'} />
              {settings.has_secret ? sc('config.secret_stored') : sc('config.secret_missing')}
            </dd>
          </div>
          <div className="min-w-0">
            <dt className="text-gray-400">{sc('config.field_webhook_id')}</dt>
            <dd className="font-mono text-gray-700 truncate">
              {settings.webhook_id || <span className="font-sans text-amber-700">{sc('config.webhook_missing')}</span>}
            </dd>
          </div>
          {config.provider_specific_id && (
            <div className="min-w-0">
              <dt className="text-gray-400">{sc('config.field_app_id')}</dt>
              <dd className="font-mono text-gray-700 truncate">{config.provider_specific_id}</dd>
            </div>
          )}
        </dl>
      )}

      {/* Credentials could not be validated */}
      {config && !isConnected && !isEditing && (
        <div className="bg-amber-50 border-t border-amber-100 px-5 py-2 text-xs text-amber-800 flex items-start gap-1.5">
          <AlertTriangle size={12} className="shrink-0 mt-0.5" />
          <span>{sc('config.invalid_hint')}</span>
        </div>
      )}

      {isEditing && (
        <PaypalCredentialsForm
          config={config}
          orgId={orgId}
          accessToken={accessToken}
          sc={sc}
          onDone={() => setIsEditing(false)}
          onCancel={() => setIsEditing(false)}
        />
      )}
    </div>
  );
};

interface PaypalCredentialsFormProps {
  config: any | undefined;
  orgId: number;
  accessToken: string;
  sc: ScTranslate;
  onDone: () => void;
  onCancel: () => void;
}

function PaypalCredentialsForm({ config, orgId, accessToken, sc, onDone, onCancel }: PaypalCredentialsFormProps) {
  const queryClient = useQueryClient();
  const settings = config?.settings ?? {};
  const hasStoredSecret = !!settings.has_secret;
  const [clientId, setClientId] = useState<string>(settings.client_id ?? '');
  // The secret is write-only: the field always starts empty.
  const [clientSecret, setClientSecret] = useState('');
  const [environment, setEnvironment] = useState<PaypalEnvironment>(settings.environment === 'live' ? 'live' : 'sandbox');
  const [webhookId, setWebhookId] = useState<string>(settings.webhook_id ?? '');
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const webhookUrl = useMemo(() => {
    // The backend knows its public base URL; fall back to the API URL we use.
    if (typeof settings.webhook_url === 'string' && settings.webhook_url) return settings.webhook_url as string;
    try {
      const base = new URL(getAPIUrl(), typeof window !== 'undefined' ? window.location.origin : undefined);
      return new URL(`payments/webhooks/paypal/${orgId}`, base).toString();
    } catch {
      return `${getAPIUrl()}payments/webhooks/paypal/${orgId}`;
    }
  }, [orgId, settings.webhook_url]);

  const copyWebhookUrl = async () => {
    try {
      await navigator.clipboard.writeText(webhookUrl);
      toast.success(sc('config.copied'));
    } catch {
      /* clipboard blocked: the URL is visible and selectable */
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);
    const trimmedId = clientId.trim();
    const trimmedSecret = clientSecret.trim();
    if (!trimmedId) {
      setFormError(sc('config.client_id_required'));
      return;
    }
    if (!trimmedSecret && !hasStoredSecret) {
      setFormError(sc('config.secret_required'));
      return;
    }

    setSubmitting(true);
    try {
      const payload = {
        client_id: trimmedId,
        environment,
        webhook_id: webhookId.trim() || null,
        ...(trimmedSecret ? { client_secret: trimmedSecret } : {}),
      };
      const res = config
        ? await updatePaypalConfig(orgId, config.id, payload, accessToken)
        : await createPaypalConfig(orgId, { ...payload, client_secret: trimmedSecret }, accessToken);

      if (!res.success) {
        setFormError(describePaymentError(res.data, sc, 'config.save_error'));
        return;
      }
      await queryClient.invalidateQueries({ queryKey: queryKeys.payments.configs(orgId) });
      setClientSecret('');
      if (res.data && res.data.active === false) {
        // Saved, but PayPal did not accept the credentials.
        setFormError(sc('config.saved_not_validated'));
        return;
      }
      toast.success(sc('config.saved'));
      onDone();
    } catch {
      setFormError(sc('config.save_error'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="border-t border-[#EAE8F2] bg-[#FFFCF9] px-5 py-4 space-y-4" autoComplete="off">
      <p className="text-xs text-[#584F72]">
        {sc('config.form_intro')}{' '}
        <a href={PAYPAL_DEVELOPER_URL} target="_blank" rel="noopener noreferrer" className="underline text-[#4F43A4]">
          {sc('config.paypal_developer_link')}
        </a>
      </p>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="space-y-1">
          <Label htmlFor="paypal_client_id">{sc('config.field_client_id')}</Label>
          <Input
            id="paypal_client_id"
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
            placeholder={sc('config.client_id_placeholder')}
            className="font-mono text-xs"
            spellCheck={false}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="paypal_client_secret">{sc('config.field_secret')}</Label>
          <Input
            id="paypal_client_secret"
            type="password"
            autoComplete="new-password"
            value={clientSecret}
            onChange={(e) => setClientSecret(e.target.value)}
            placeholder={hasStoredSecret ? sc('config.secret_keep_placeholder') : sc('config.secret_placeholder')}
            className="font-mono text-xs"
            spellCheck={false}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="paypal_environment">{sc('config.field_environment')}</Label>
          <Select value={environment} onValueChange={(v) => setEnvironment(v === 'live' ? 'live' : 'sandbox')}>
            <SelectTrigger id="paypal_environment">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="sandbox">{sc('config.env_sandbox_long')}</SelectItem>
              <SelectItem value="live">{sc('config.env_live_long')}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="paypal_webhook_id">
            {sc('config.field_webhook_id')} <span className="text-gray-400 font-normal">({sc('config.optional_recommended')})</span>
          </Label>
          <Input
            id="paypal_webhook_id"
            value={webhookId}
            onChange={(e) => setWebhookId(e.target.value)}
            placeholder={sc('config.webhook_id_placeholder')}
            className="font-mono text-xs"
            spellCheck={false}
          />
        </div>
      </div>

      {/* Webhook setup help */}
      <div className="rounded-lg border border-[#EAE8F2] bg-white px-4 py-3 space-y-2">
        <p className="text-xs font-semibold text-[#190933]">{sc('config.webhook_help_title')}</p>
        <p className="text-xs text-[#584F72]">{sc('config.webhook_help')}</p>
        <div className="flex items-center gap-2">
          <code className="flex-1 min-w-0 truncate text-[11px] bg-[#EEEDFF] text-[#190933] rounded px-2 py-1">{webhookUrl}</code>
          <button
            type="button"
            onClick={copyWebhookUrl}
            className="shrink-0 text-[#6559CA] hover:text-[#4F43A4]"
            title={sc('config.copy')}
            aria-label={sc('config.copy')}
          >
            <Copy size={14} />
          </button>
        </div>
        <p className="text-[11px] text-gray-500">
          {sc('config.webhook_events')} <span className="font-mono">{PAYPAL_WEBHOOK_EVENTS.join(', ')}</span>
        </p>
      </div>

      {environment === 'live' && (
        <p className="text-xs text-amber-800 bg-amber-50 border border-amber-100 rounded-lg px-3 py-2 flex items-start gap-1.5">
          <AlertTriangle size={12} className="shrink-0 mt-0.5" />
          {sc('config.live_warning')}
        </p>
      )}

      {formError && (
        <p role="alert" className="text-sm text-red-700 bg-red-50 border border-red-100 rounded-lg px-3 py-2">
          {formError}
        </p>
      )}

      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" className="rounded-full" onClick={onCancel} disabled={submitting}>
          {sc('common.cancel')}
        </Button>
        <Button type="submit" className="rounded-full bg-[#190933] text-white hover:bg-[#41375B]" disabled={submitting}>
          {submitting ? <Loader2 size={14} className="animate-spin me-1" /> : null}
          {submitting ? sc('config.validating') : sc('config.save_and_validate')}
        </Button>
      </div>
    </form>
  );
}

export default PaymentsConfigurationPage;
