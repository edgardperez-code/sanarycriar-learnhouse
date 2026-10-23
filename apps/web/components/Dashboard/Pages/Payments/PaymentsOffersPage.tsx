'use client';
// Sanar y Criar: offers are one-time purchases in a provider-supported
// currency (USD by default). Subscription and "pay what you want" options are
// hidden because the checkout providers do not support them.
import React, { useState } from 'react';
import Link from 'next/link';
import { useOrg } from '@components/Contexts/OrgContext';
import { useLHSession } from '@components/Contexts/LHSessionContext';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { queryKeys } from '@/lib/query/keys';
import { getOffers, updateOffer, archiveOffer } from '@services/payments/offers';
import { getUriWithOrg } from '@services/config/config';
import { Plus, Pencil, Info, RefreshCcw, SquareCheck, ChevronDown, ChevronUp, Archive, BookOpen, Layers, ExternalLink } from 'lucide-react';
import Modal from '@components/Objects/StyledElements/Modal/Modal';
import toast from 'react-hot-toast';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@components/ui/select';
import { Button } from '@components/ui/button';
import { Input } from '@components/ui/input';
import { Textarea } from '@components/ui/textarea';
import { Formik, Form, Field, ErrorMessage } from 'formik';
import * as Yup from 'yup';
import { Label } from '@components/ui/label';
import { Badge } from '@components/ui/badge';
import { usePaymentsEnabled } from '@hooks/usePaymentsEnabled';
import UnconfiguredPaymentsDisclaimer from '@components/Pages/Payments/UnconfiguredPaymentsDisclaimer';
import CreateOfferForm from './SubComponents/CreateOfferForm';
import OfferResourcesPanel from './SubComponents/OfferResourcesPanel';
// Sanar y Criar: warns when archiving would make a course free for everyone.
import ArchiveOfferDialog from './SubComponents/ArchiveOfferDialog';
import { normalizeBillingInterval } from '@lib/payments/billingInterval';
import { formatCurrency } from '@/lib/format';
import { useScT, ScTranslate } from '@components/Payments/useScT';
import { useCheckoutProviders } from '@components/Payments/useCheckoutProviders';
import { describePaymentError } from '@components/Payments/commerce';

const editValidationSchema = (sc: ScTranslate) => Yup.object().shape({
  name: Yup.string().required(sc('offers.name_required')),
  description: Yup.string().required(sc('offers.description_required')),
  amount: Yup.number().typeError(sc('offers.amount_min')).min(1, sc('offers.amount_min')).required(sc('offers.amount_required')),
  benefits: Yup.string(),
  currency: Yup.string().required(sc('offers.currency_required')),
});

function PaymentsOffersPage() {
  const org = useOrg() as any;
  const session = useLHSession() as any;
  const queryClient = useQueryClient();
  const { sc, lng } = useScT();
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [editingOfferId, setEditingOfferId] = useState<string | null>(null);
  const [expandedOffers, setExpandedOffers] = useState<{ [key: string]: boolean }>({});
  const [resourcesPanelOffer, setResourcesPanelOffer] = useState<any>(null);
  // Sanar y Criar: kept after closing so the dialog can animate out.
  const [archiveTarget, setArchiveTarget] = useState<{ offer: any; key: number; open: boolean } | null>(null);
  const { isEnabled, isLoading } = usePaymentsEnabled();

  const { data: offers, error } = useQuery({
    queryKey: queryKeys.payments.offers(org?.id),
    queryFn: () => getOffers(org.id, session.data?.tokens?.access_token),
    enabled: !!(org?.id && session?.data?.tokens?.access_token),
    staleTime: 60_000,
  });

  const handleArchiveOffer = async (offerId: string | number): Promise<boolean> => {
    const res = await archiveOffer(org.id, String(offerId), session.data?.tokens?.access_token);
    queryClient.invalidateQueries({ queryKey: queryKeys.payments.offers(org.id) });
    // The store, course pages and paywall read offers too.
    queryClient.invalidateQueries({ queryKey: ['offers', 'by-resource'] });
    queryClient.invalidateQueries({ queryKey: ['payments', org.id, 'access'] });
    if (res.status === 200) {
      toast.success(sc('offers.archived'));
      return true;
    }
    toast.error(describePaymentError(res.data, sc, 'offers.archive_error'));
    return false;
  };

  const toggleExpansion = (offerId: string) => {
    setExpandedOffers((prev) => ({ ...prev, [offerId]: !prev[offerId] }));
  };

  if (!isEnabled && !isLoading) {
    return <UnconfiguredPaymentsDisclaimer />;
  }

  if (error) return <div className="p-8 text-sm text-red-500">{sc('offers.load_error')}</div>;
  if (!offers) return (
    <div className="min-h-full w-full bg-[#f8f8f8]">
      <div className="ps-4 pe-4 sm:ps-10 sm:pe-10 mx-auto animate-pulse">
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {[1, 2, 3].map((i) => (
            <div key={i} className="bg-white p-4 rounded-lg nice-shadow space-y-3">
              <div className="h-5 bg-gray-200 rounded w-1/3" />
              <div className="h-6 bg-gray-200 rounded w-2/3" />
              <div className="h-3 bg-gray-100 rounded w-full" />
              <div className="h-3 bg-gray-100 rounded w-4/5" />
              <div className="h-10 bg-gray-100 rounded w-full mt-4" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );

  // getResponseMetadata never throws: a failed call still lands here.
  const offerList: any[] = Array.isArray(offers?.data) ? offers.data : [];
  if (!offers.success) {
    return <div className="p-8 text-sm text-red-500">{describePaymentError(offers.data, sc, 'offers.load_error')}</div>;
  }

  // Sanar y Criar: min-h-full (not h-full) so the list grows its own box and the
  // dock spacer after it in the payments page stays below the last offer; 16px
  // side margins on phones, as in the page header.
  return (
    <div className="min-h-full w-full bg-[#f8f8f8]">
      <div className="ps-4 pe-4 sm:ps-10 sm:pe-10 mx-auto">
        <Modal
          isDialogOpen={isCreateModalOpen}
          onOpenChange={setIsCreateModalOpen}
          dialogTitle={sc('offers.create_title')}
          dialogDescription={sc('offers.create_description')}
          dialogContent={<CreateOfferForm onSuccess={() => setIsCreateModalOpen(false)} />}
        />

        {resourcesPanelOffer && (
          <Modal
            isDialogOpen={!!resourcesPanelOffer}
            onOpenChange={(open) => { if (!open) setResourcesPanelOffer(null); }}
            dialogTitle={sc('offers.resources_title', { name: resourcesPanelOffer.name })}
            dialogDescription={sc('offers.resources_description')}
            dialogContent={
              <OfferResourcesPanel
                offerId={resourcesPanelOffer.id}
                offerName={resourcesPanelOffer.name}
              />
            }
          />
        )}

        <ArchiveOfferDialog
          offer={archiveTarget?.offer ?? null}
          open={!!archiveTarget?.open}
          requestKey={archiveTarget?.key ?? null}
          onClose={() => setArchiveTarget((current) => (current ? { ...current, open: false } : null))}
          onArchive={handleArchiveOffer}
        />

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {offerList.map((offer: any) => (
            <div key={offer.id} className="bg-white p-4 rounded-[20px] nice-shadow flex flex-col h-full">
              {editingOfferId === String(offer.id) ? (
                <EditOfferForm
                  offer={offer}
                  onSuccess={() => setEditingOfferId(null)}
                  onCancel={() => setEditingOfferId(null)}
                />
              ) : (
                <div className="flex flex-col h-full">
                  <div className="flex justify-between items-start mb-2">
                    <div className="flex flex-col space-y-1 items-start">
                      <Badge className="w-fit flex items-center space-x-2 rounded-full" variant="outline">
                        {offer.offer_type === 'subscription' ? <RefreshCcw size={12} /> : <SquareCheck size={12} />}
                        <span className="text-sm">
                          {offer.offer_type === 'subscription' ? sc('offers.type_subscription') : sc('offers.type_one_time')}
                        </span>
                      </Badge>
                      <h3 className="font-bold text-lg text-[#190933]">{offer.name}</h3>
                    </div>
                    <div className="flex space-x-2">
                      <button
                        onClick={() => setEditingOfferId(String(offer.id))}
                        className="text-[#6559CA] hover:text-[#4F43A4]"
                        title={sc('offers.edit')}
                      >
                        <Pencil size={16} />
                      </button>
                      <button
                        onClick={() => setArchiveTarget({ offer, key: Date.now(), open: true })}
                        className="text-red-500 hover:text-red-700"
                        title={sc('offers.archive')}
                        aria-label={sc('offers.archive')}
                      >
                        <Archive size={16} />
                      </button>
                    </div>
                  </div>

                  <div className="grow overflow-hidden">
                    <div
                      className={`transition-all duration-300 ease-in-out ${
                        expandedOffers[offer.id] ? 'max-h-[1000px]' : 'max-h-24'
                      } overflow-hidden`}
                    >
                      <p className="text-gray-600">{offer.description}</p>
                      {offer.benefits && (
                        <div className="mt-2">
                          <h4 className="font-semibold text-sm">{sc('offers.benefits')}</h4>
                          <p className="text-sm text-gray-600">{offer.benefits}</p>
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="mt-2">
                    <button
                      onClick={() => toggleExpansion(String(offer.id))}
                      className="text-slate-500 hover:text-slate-700 text-sm flex items-center"
                    >
                      {expandedOffers[offer.id] ? (
                        <><ChevronUp size={16} /><span>{sc('common.show_less')}</span></>
                      ) : (
                        <><ChevronDown size={16} /><span>{sc('common.show_more')}</span></>
                      )}
                    </button>
                  </div>

                  {offer.payments_group_id && (
                    <div className="mt-1.5 flex items-center gap-1.5 text-xs text-[#6559CA]">
                      <Layers size={12} />
                      <span>{sc('offers.payment_group', { id: offer.payments_group_id })}</span>
                    </div>
                  )}

                  <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1">
                    <button
                      onClick={() => setResourcesPanelOffer(offer)}
                      className="text-sm flex items-center space-x-1 text-[#6559CA] hover:text-[#4F43A4]"
                    >
                      <BookOpen size={14} />
                      <span>{sc('offers.manage_resources')}</span>
                    </button>
                    <Link
                      href={getUriWithOrg(org?.slug, `/store/offers/${offer.offer_uuid ?? offer.id}`)}
                      target="_blank"
                      className="text-sm flex items-center space-x-1 text-[#6559CA] hover:text-[#4F43A4]"
                    >
                      <ExternalLink size={14} />
                      <span>{sc('offers.view_in_store')}</span>
                    </Link>
                  </div>

                  <div className="mt-2 flex items-center justify-between bg-[#EEEDFF] rounded-md p-2">
                    <span className="text-sm text-[#584F72]">{sc('offers.price')}</span>
                    <span className="font-semibold text-lg text-[#190933]">
                      {formatCurrency(Number(offer.amount), offer.currency || 'USD', lng)}
                    </span>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>

        {offerList.length === 0 && (
          <div className="flex mx-auto space-x-2 font-semibold mt-3 text-gray-600 items-center">
            <Info size={20} />
            <p>{sc('offers.empty')}</p>
          </div>
        )}

        <div className="flex justify-center items-center py-10">
          <button
            onClick={() => setIsCreateModalOpen(true)}
            className="mb-4 flex items-center space-x-2 px-4 py-2 rounded-full bg-[#190933] text-white font-medium hover:bg-[#41375B] nice-shadow transition duration-300"
          >
            <Plus size={18} />
            <span className="text-sm font-bold">{sc('offers.create_button')}</span>
          </button>
        </div>
      </div>
    </div>
  );
}

const EditOfferForm = ({
  offer,
  onSuccess,
  onCancel,
}: {
  offer: any;
  onSuccess: () => void;
  onCancel: () => void;
}) => {
  const org = useOrg() as any;
  const session = useLHSession() as any;
  const queryClient = useQueryClient();
  const { sc } = useScT();
  const { currencies: supported } = useCheckoutProviders(org?.id);
  const currencies = Array.from(new Set([...supported, (offer.currency || 'USD').toUpperCase()]));

  const initialValues = {
    name: offer.name,
    description: offer.description,
    amount: offer.amount,
    benefits: offer.benefits || '',
    currency: (offer.currency || 'USD').toUpperCase(),
    // Not editable here (only one-time, fixed-price offers are sold), but the
    // PUT body keeps the stored values so nothing changes behind the admin's back.
    offer_type: (offer.offer_type || 'one_time') as 'one_time' | 'subscription',
    price_type: (offer.price_type || 'fixed_price') as 'fixed_price' | 'customer_choice',
    billing_interval: normalizeBillingInterval(offer.billing_interval),
  };

  const handleSubmit = async (
    values: typeof initialValues,
    { setSubmitting }: { setSubmitting: (b: boolean) => void }
  ) => {
    try {
      const res = await updateOffer(org.id, offer.id, values, session.data?.tokens?.access_token);
      if (!res?.success) {
        toast.error(describePaymentError(res?.data, sc, 'offers.update_error'));
        return;
      }
      queryClient.invalidateQueries({ queryKey: queryKeys.payments.offers(org.id) });
      queryClient.invalidateQueries({ queryKey: ['offers', 'by-resource'] });
      queryClient.invalidateQueries({ queryKey: ['payments', org.id, 'access'] });
      onSuccess();
      toast.success(sc('offers.updated'));
    } catch {
      toast.error(sc('offers.update_error'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Formik initialValues={initialValues} validationSchema={editValidationSchema(sc)} onSubmit={handleSubmit}>
      {({ isSubmitting, values, setFieldValue }) => (
        <Form className="space-y-4">
          <div className="px-1.5 py-2 flex-col space-y-3">
            <div>
              <Label htmlFor="name">{sc('offers.field_name')}</Label>
              <Field name="name" as={Input} placeholder={sc('offers.field_name')} />
              <ErrorMessage name="name" component="div" className="text-red-500 text-sm mt-1" />
            </div>

            <div>
              <Label htmlFor="description">{sc('offers.field_description')}</Label>
              <Field name="description" as={Textarea} placeholder={sc('offers.field_description')} />
              <ErrorMessage name="description" component="div" className="text-red-500 text-sm mt-1" />
            </div>

            <div className="flex space-x-2">
              <div className="grow">
                <Label htmlFor="amount">{sc('offers.field_price')}</Label>
                <Field name="amount" as={Input} type="number" min={1} step="0.01" placeholder={sc('offers.field_price')} />
                <ErrorMessage name="amount" component="div" className="text-red-500 text-sm mt-1" />
              </div>
              <div className="w-1/3">
                <Label htmlFor="currency">{sc('offers.field_currency')}</Label>
                <Select
                  value={values.currency}
                  onValueChange={(value) => setFieldValue('currency', value)}
                >
                  <SelectTrigger>
                    <SelectValue placeholder={sc('offers.field_currency')} />
                  </SelectTrigger>
                  <SelectContent>
                    {currencies.map((code) => (
                      <SelectItem key={code} value={code}>
                        {code}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <ErrorMessage name="currency" component="div" className="text-red-500 text-sm mt-1" />
              </div>
            </div>

            <div>
              <Label htmlFor="benefits">{sc('offers.field_benefits')}</Label>
              <Field name="benefits" as={Textarea} placeholder={sc('offers.field_benefits_placeholder')} />
            </div>
          </div>

          <div className="flex justify-end space-x-2">
            <Button type="button" variant="outline" className="rounded-full" onClick={onCancel}>{sc('common.cancel')}</Button>
            <Button type="submit" className="rounded-full bg-[#190933] text-white hover:bg-[#41375B]" disabled={isSubmitting}>
              {isSubmitting ? sc('common.saving') : sc('common.save')}
            </Button>
          </div>
        </Form>
      )}
    </Formik>
  );
};

export default PaymentsOffersPage;
