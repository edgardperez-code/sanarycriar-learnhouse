'use client';
// Sanar y Criar: one-time, fixed-price offers only (the checkout providers do
// not support subscriptions or pay-what-you-want); the currency list is
// limited to what the active providers can charge, USD by default.
import React from 'react';
import { useOrg } from '@components/Contexts/OrgContext';
import { useLHSession } from '@components/Contexts/LHSessionContext';
import { createOffer } from '@services/payments/offers';
import { getPaymentsGroups } from '@services/payments/groups';
import { Formik, Form, Field, ErrorMessage } from 'formik';
import * as Yup from 'yup';
import toast from 'react-hot-toast';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { queryKeys } from '@/lib/query/keys';
import { useLHAnalytics, AnalyticsEvent } from '@services/analytics';
import { meaningfulMessage } from '@lib/errors/classify';
import { Button } from '@components/ui/button';
import { Input } from '@components/ui/input';
import { Textarea } from '@components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@components/ui/select';
import { Label } from '@components/ui/label';
import { BookOpen, BookMarked, X, Plus, Layers } from 'lucide-react';
import { getOrgCourses } from '@services/courses/courses';
import { useScT, ScTranslate } from '@components/Payments/useScT';
import { useCheckoutProviders } from '@components/Payments/useCheckoutProviders';
import { describePaymentError, productTypeOfCourse } from '@components/Payments/commerce';

const validationSchema = (sc: ScTranslate) => Yup.object().shape({
  name: Yup.string().required(sc('offers.name_required')),
  description: Yup.string().required(sc('offers.description_required')),
  amount: Yup.number().typeError(sc('offers.amount_min')).min(1, sc('offers.amount_min')).required(sc('offers.amount_required')),
  benefits: Yup.string(),
  currency: Yup.string().required(sc('offers.currency_required')),
  resource_uuids: Yup.array().of(Yup.string()),
});

interface OfferFormValues {
  name: string;
  description: string;
  offer_type: 'one_time';
  price_type: 'fixed_price';
  billing_interval: 'month' | 'year';
  benefits: string;
  amount: number;
  currency: string;
  payments_group_id: number | '';
  resource_uuids: string[];
}

const courseResourceUuid = (c: any) => `course_${c.course_uuid?.replace('course_', '')}`;

const CreateOfferForm: React.FC<{ onSuccess: () => void }> = ({ onSuccess }) => {
  const org = useOrg() as any;
  const session = useLHSession() as any;
  const token = session?.data?.tokens?.access_token;
  const queryClient = useQueryClient();
  const { track } = useLHAnalytics('dashboard');
  const { sc } = useScT();
  const { currencies } = useCheckoutProviders(org?.id);

  // Payment Groups for the optional group picker
  const { data: groupsResult } = useQuery({
    queryKey: queryKeys.payments.groups(org?.id),
    queryFn: () => getPaymentsGroups(org.id, token),
    enabled: !!(org?.id && token),
    staleTime: 60_000,
  });
  const groups: any[] = Array.isArray(groupsResult?.data) ? groupsResult.data : Array.isArray(groupsResult) ? groupsResult : [];

  // Courses (and ebooks, which are courses with product_type 'ebook')
  const { data: courses } = useQuery({
    queryKey: queryKeys.courses.list(org?.slug ?? ''),
    queryFn: () => getOrgCourses(org.slug, null, token, true),
    enabled: !!(org?.slug && token),
    staleTime: 60_000,
  });
  const courseList: any[] = Array.isArray(courses) ? courses : [];

  const initialValues: OfferFormValues = {
    name: '',
    description: '',
    offer_type: 'one_time',
    price_type: 'fixed_price',
    billing_interval: 'month',
    benefits: '',
    amount: 1,
    currency: 'USD',
    payments_group_id: '',
    resource_uuids: [],
  };

  const handleSubmit = async (values: OfferFormValues, { setSubmitting, resetForm }: any) => {
    if (values.resource_uuids.length === 0 && values.payments_group_id === '') {
      toast.error(sc('offer_form.resource_required'));
      setSubmitting(false);
      return;
    }
    try {
      const payload = {
        ...values,
        payments_group_id: values.payments_group_id !== '' ? values.payments_group_id : undefined,
      };
      const res = await createOffer(org.id, payload, token);
      if (res.success) {
        track(AnalyticsEvent.OfferCreated, {
          offer_type: values.offer_type,
          price_type: values.price_type,
          amount: values.amount,
        });
        toast.success(sc('offer_form.created'));
        queryClient.invalidateQueries({ queryKey: queryKeys.payments.offers(org.id) });
        queryClient.invalidateQueries({ queryKey: ['offers', 'by-resource'] });
        queryClient.invalidateQueries({ queryKey: ['payments', org.id, 'access'] });
        resetForm();
        onSuccess();
      } else {
        toast.error(describePaymentError(res.data, sc, 'offer_form.create_error'));
      }
    } catch (error) {
      toast.error(meaningfulMessage(error));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Formik initialValues={initialValues} validationSchema={validationSchema(sc)} onSubmit={handleSubmit}>
      {({ isSubmitting, values, setFieldValue }) => (
        <Form className="space-y-4">
          <div className="px-1.5 py-2 flex-col space-y-3">
            <div>
              <Label htmlFor="name">{sc('offers.field_name')}</Label>
              <Field name="name" as={Input} placeholder={sc('offer_form.name_placeholder')} />
              <ErrorMessage name="name" component="div" className="text-red-500 text-sm mt-1" />
            </div>

            <div>
              <Label htmlFor="description">{sc('offers.field_description')}</Label>
              <Field name="description" as={Textarea} placeholder={sc('offer_form.description_placeholder')} />
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
                    {Array.from(new Set(['USD', ...currencies])).map((code) => (
                      <SelectItem key={code} value={code}>
                        {code}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <ErrorMessage name="currency" component="div" className="text-red-500 text-sm mt-1" />
              </div>
            </div>
            <p className="text-xs text-gray-500 -mt-1">{sc('offer_form.one_time_note')}</p>

            <div>
              <Label htmlFor="benefits">{sc('offers.field_benefits')}</Label>
              <Field name="benefits" as={Textarea} placeholder={sc('offers.field_benefits_placeholder')} />
              <ErrorMessage name="benefits" component="div" className="text-red-500 text-sm mt-1" />
            </div>

            {/* ── Access ───────────────────────────────────────────────── */}
            <div className="border border-[#EAE8F2] rounded-xl p-3 space-y-3 bg-[#FFFCF9]">
              <p className="text-xs font-semibold text-[#AC4691] uppercase tracking-[0.18em]">{sc('offer_form.access_title')}</p>
              <p className="text-xs text-gray-500">{sc('offer_form.access_help')}</p>

              {/* Direct course / ebook picker */}
              <div>
                <Label className="text-xs">{sc('offer_form.courses_label')}</Label>
                {values.resource_uuids.length > 0 && (
                  <ul className="mb-1 space-y-0.5">
                    {values.resource_uuids.map((uuid) => {
                      const course = courseList.find((c: any) => courseResourceUuid(c) === uuid);
                      const isEbook = productTypeOfCourse(course) === 'ebook';
                      return (
                        <li key={uuid} className="flex items-center justify-between bg-white rounded px-2 py-1 text-xs border">
                          <div className="flex items-center gap-1.5">
                            {isEbook ? <BookMarked size={11} className="text-[#AC4691]" /> : <BookOpen size={11} className="text-[#6559CA]" />}
                            <span>{course?.name ?? uuid}</span>
                            {isEbook && <span className="text-[10px] text-[#AC4691]">({sc('product.ebook')})</span>}
                          </div>
                          <button
                            type="button"
                            onClick={() =>
                              setFieldValue(
                                'resource_uuids',
                                values.resource_uuids.filter((u) => u !== uuid)
                              )
                            }
                            className="text-red-400 hover:text-red-600"
                            title={sc('common.remove')}
                          >
                            <X size={11} />
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}
                <Select
                  value=""
                  onValueChange={(courseUuid) => {
                    if (courseUuid && !values.resource_uuids.includes(courseUuid)) {
                      setFieldValue('resource_uuids', [...values.resource_uuids, courseUuid]);
                    }
                  }}
                >
                  <SelectTrigger className="text-xs h-8">
                    <div className="flex items-center gap-1 text-gray-500">
                      <Plus size={11} />
                      <span>{sc('offer_form.add_course')}</span>
                    </div>
                  </SelectTrigger>
                  <SelectContent>
                    {/* Picked items stay listed (disabled) so the admin sees
                        what is already included. */}
                    {courseList.map((c: any) => {
                      const uuid = courseResourceUuid(c);
                      const isEbook = productTypeOfCourse(c) === 'ebook';
                      return (
                        <SelectItem key={uuid} value={uuid} disabled={values.resource_uuids.includes(uuid)}>
                          {c.name}{isEbook ? ` (${sc('product.ebook')})` : ''}
                        </SelectItem>
                      );
                    })}
                  </SelectContent>
                </Select>
                <p className="text-[11px] text-gray-400 mt-1">{sc('offer_form.published_note')}</p>
              </div>

              {/* Payment Group picker */}
              <div>
                <Label className="text-xs">
                  {sc('offer_form.group_label')} <span className="text-gray-400 font-normal">({sc('offer_form.group_optional')})</span>
                </Label>
                <Select
                  value={String(values.payments_group_id)}
                  onValueChange={(value) =>
                    setFieldValue('payments_group_id', value === 'none' ? '' : Number(value))
                  }
                >
                  <SelectTrigger className="text-xs">
                    <SelectValue placeholder={sc('offer_form.group_placeholder')} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">{sc('offer_form.group_none')}</SelectItem>
                    {groups.map((g: any) => (
                      <SelectItem key={g.id} value={String(g.id)}>
                        <div className="flex items-center gap-1.5">
                          <Layers size={11} className="text-[#6559CA]" />
                          {g.name}
                        </div>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-gray-400 mt-1">{sc('offer_form.group_help')}</p>
              </div>
            </div>
          </div>

          <div className="flex justify-end">
            <Button type="submit" className="rounded-full bg-[#190933] text-white hover:bg-[#41375B]" disabled={isSubmitting}>
              {isSubmitting ? sc('offer_form.creating') : sc('offer_form.create')}
            </Button>
          </div>
        </Form>
      )}
    </Formik>
  );
};

export default CreateOfferForm;
