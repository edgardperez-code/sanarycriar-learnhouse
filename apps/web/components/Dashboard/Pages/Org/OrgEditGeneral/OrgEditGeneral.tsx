'use client'
import React from 'react'
import { Form, Formik } from 'formik'
import * as Yup from 'yup'
import {
  updateOrganization,
  updateOrgFooterTextConfig,
  updateOrgEmailSenderNameConfig,
  updateOrgDefaultLanguageConfig,
} from '@services/settings/org'
import { AVAILABLE_LANGUAGES } from '@/lib/languages'
import { revalidateTags } from '@services/utils/ts/requests'
import { useRouter } from 'next/navigation'
import { useOrg } from '@components/Contexts/OrgContext'
import { useLHSession } from '@components/Contexts/LHSessionContext'
import { toast } from 'react-hot-toast'
import { Input } from "@components/ui/input"
import { Textarea } from "@components/ui/textarea"
import { Button } from "@components/ui/button"
import { Label } from "@components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@components/ui/select"
import { useQueryClient } from '@tanstack/react-query'
import { queryKeys } from '@/lib/query/keys'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { useLHAnalytics, AnalyticsEvent } from '@services/analytics'

// Sanar y Criar: the text of each label comes from
// sc_ui.org_general.labels.<value>; only the emoji lives here.
const ORG_LABELS = [
  { value: 'languages', emoji: '🌐' },
  { value: 'business', emoji: '💰' },
  { value: 'ecommerce', emoji: '🛍' },
  { value: 'gaming', emoji: '🎮' },
  { value: 'music', emoji: '🎸' },
  { value: 'sports', emoji: '⚽' },
  { value: 'cars', emoji: '🚗' },
  { value: 'sales_marketing', emoji: '🚀' },
  { value: 'tech', emoji: '💻' },
  { value: 'photo_video', emoji: '📸' },
  { value: 'pets', emoji: '🐕' },
  { value: 'personal_development', emoji: '📚' },
  { value: 'real_estate', emoji: '🏠' },
  { value: 'beauty_fashion', emoji: '👠' },
  { value: 'travel', emoji: '✈️' },
  { value: 'productivity', emoji: '⏳' },
  { value: 'health_fitness', emoji: '🍎' },
  { value: 'finance', emoji: '📈' },
  { value: 'arts_crafts', emoji: '🎨' },
  { value: 'education', emoji: '📚' },
  { value: 'stem', emoji: '🔬' },
  { value: 'humanities', emoji: '📖' },
  { value: 'professional_skills', emoji: '💼' },
  { value: 'digital_skills', emoji: '💻' },
  { value: 'creative_arts', emoji: '🎨' },
  { value: 'social_sciences', emoji: '🌍' },
  { value: 'test_prep', emoji: '✍️' },
  { value: 'vocational', emoji: '🔧' },
  { value: 'early_education', emoji: '🎯' },
] as const

// Mirrors MAX_SENDER_NAME_LENGTH in apps/api/src/services/email/sender.py, which
// re-validates (and sanitizes) every submitted value server-side.
const MAX_EMAIL_SENDER_NAME_LENGTH = 64

const MAX_NAME_LENGTH = 60
const MAX_DESCRIPTION_LENGTH = 100
const MAX_ABOUT_LENGTH = 400
const MAX_FOOTER_TEXT_LENGTH = 100

// Sanar y Criar: built per render so the messages follow the UI language.
function buildValidationSchema(t: TFunction) {
  const v = (key: string, max?: number) => t(`sc_ui.org_general.validation.${key}`, { max })
  return Yup.object().shape({
    name: Yup.string()
      .required(v('name_required'))
      .max(MAX_NAME_LENGTH, v('name_max', MAX_NAME_LENGTH)),
    description: Yup.string()
      .required(v('description_required'))
      .max(MAX_DESCRIPTION_LENGTH, v('description_max', MAX_DESCRIPTION_LENGTH)),
    about: Yup.string()
      .optional()
      .max(MAX_ABOUT_LENGTH, v('about_max', MAX_ABOUT_LENGTH)),
    label: Yup.string().required(v('label_required')),
  })
}

interface OrganizationValues {
  name: string
  description: string
  about: string
  label: string
}

const OrgEditGeneral: React.FC = () => {
  const { t } = useTranslation()
  const validationSchema = React.useMemo(() => buildValidationSchema(t), [t])
  // Sanar y Criar: "(N characters left)" next to each label, translated; a
  // stored value already past the limit says so instead of a negative count.
  const charsLeft = (max: number, value?: string) => {
    const left = max - (value?.length || 0)
    return left >= 0
      ? `(${t('sc_ui.common.characters_left', { count: left })})`
      : `(${t('sc_ui.common.characters_over', { count: -left })})`
  }
  const _router = useRouter()
  const session = useLHSession() as any
  const access_token = session?.data?.tokens?.access_token
  const org = useOrg() as any
  const queryClient = useQueryClient()
  const { track } = useLHAnalytics('dashboard')

  // Footer text state
  const [footerText, setFooterText] = React.useState<string>(org?.config?.config?.customization?.general?.footer_text || org?.config?.config?.general?.footer_text || '')
  const [_isFooterSaving, _setIsFooterSaving] = React.useState(false)

  // Email sender display name state
  const [emailSenderName, setEmailSenderName] = React.useState<string>(
    org?.config?.config?.customization?.general?.email_sender_name ||
    org?.config?.config?.general?.email_sender_name ||
    ''
  )

  // Default language state
  const [defaultLanguage, setDefaultLanguage] = React.useState<string>(
    org?.config?.config?.customization?.general?.default_language ||
    org?.config?.config?.general?.default_language ||
    // Sanar y Criar: same default as the API (organization_config.py).
    'es'
  )

  const initialValues: OrganizationValues = {
    name: org?.name,
    description: org?.description || '',
    about: org?.about || '',
    label: org?.label || '',
  }

  const updateOrg = async (values: OrganizationValues) => {
    const loadingToast = toast.loading(t('dashboard.organization.settings.updating'))
    try {
      await updateOrganization(org.id, values, access_token)
      // Also save footer text
      await updateOrgFooterTextConfig(org.id, footerText, access_token)
      // Save the email sender display name (name only; the sending address is
      // always the platform's)
      await updateOrgEmailSenderNameConfig(org.id, emailSenderName, access_token)
      // Save default language
      await updateOrgDefaultLanguageConfig(org.id, defaultLanguage, access_token)
      await revalidateTags(['organizations'], org.slug)
      queryClient.invalidateQueries({ queryKey: queryKeys.org.detail(org.slug) })
      track(AnalyticsEvent.OrgGeneralSettingsUpdated, { default_language: defaultLanguage })
      toast.success(t('dashboard.organization.settings.update_success'), { id: loadingToast })
    } catch (_err) {
      toast.error(t('dashboard.organization.settings.update_error'), { id: loadingToast })
    }
  }

  return (
    <div className="sm:mx-10 mx-0 bg-white rounded-xl nice-shadow ">
      <Formik
        enableReinitialize
        initialValues={initialValues}
        validationSchema={validationSchema}
        onSubmit={(values, { setSubmitting }) => {
          setTimeout(() => {
            setSubmitting(false)
            updateOrg(values)
          }, 400)
        }}
      >
        {({ isSubmitting, values, handleChange, errors, touched, setFieldValue }) => (
          <Form>
            <div className="flex flex-col gap-0">
              <div className="flex flex-col bg-gray-50 -space-y-1 px-5 py-3 mx-3 my-3 rounded-md">
                <h1 className="font-bold text-xl text-gray-800">
                  {t('dashboard.organization.settings.title')}
                </h1>
                <h2 className="text-gray-500 text-md">
                  {t('dashboard.organization.settings.subtitle')}
                </h2>
              </div>

              <div className="flex flex-col lg:flex-row lg:space-x-8 mt-0 mx-5 my-5">
                <div className="w-full space-y-6">
                  <div className="space-y-4">
                    <div>
                      <Label htmlFor="name">
                        {t('dashboard.organization.settings.name')}
                        <span className="text-gray-500 text-sm ms-2">
                          {charsLeft(MAX_NAME_LENGTH, values.name)}
                        </span>
                      </Label>
                      <Input
                        id="name"
                        name="name"
                        value={values.name}
                        onChange={handleChange}
                        placeholder={t('dashboard.organization.settings.name_placeholder')}
                        maxLength={MAX_NAME_LENGTH}
                      />
                      {touched.name && errors.name && (
                        <p className="text-red-500 text-sm mt-1">{errors.name}</p>
                      )}
                    </div>

                    <div>
                      <Label htmlFor="description">
                        {t('dashboard.organization.settings.short_description')}
                        <span className="text-gray-500 text-sm ms-2">
                          {charsLeft(MAX_DESCRIPTION_LENGTH, values.description)}
                        </span>
                      </Label>
                      <Input
                        id="description"
                        name="description"
                        value={values.description}
                        onChange={handleChange}
                        placeholder={t('dashboard.organization.settings.short_description_placeholder')}
                        maxLength={MAX_DESCRIPTION_LENGTH}
                      />
                      {touched.description && errors.description && (
                        <p className="text-red-500 text-sm mt-1">{errors.description}</p>
                      )}
                    </div>

                    <div>
                      <Label htmlFor="label">{t('dashboard.organization.settings.label')}</Label>
                      <Select
                        value={values.label}
                        onValueChange={(value) => setFieldValue('label', value)}
                      >
                        <SelectTrigger>
                          <SelectValue placeholder={t('dashboard.organization.settings.label_placeholder')} />
                        </SelectTrigger>
                        <SelectContent>
                          {ORG_LABELS.map((type) => (
                            <SelectItem key={type.value} value={type.value}>
                              {type.emoji} {t(`sc_ui.org_general.labels.${type.value}`)}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      {touched.label && errors.label && (
                        <p className="text-red-500 text-sm mt-1">{errors.label}</p>
                      )}
                    </div>

                    <div>
                      <Label htmlFor="about">
                        {t('dashboard.organization.settings.about')}
                        <span className="text-gray-500 text-sm ms-2">
                          {charsLeft(MAX_ABOUT_LENGTH, values.about)}
                        </span>
                      </Label>
                      <Textarea
                        id="about"
                        name="about"
                        value={values.about}
                        onChange={handleChange}
                        placeholder={t('dashboard.organization.settings.about_placeholder')}
                        className="min-h-[250px]"
                        maxLength={MAX_ABOUT_LENGTH}
                      />
                      {touched.about && errors.about && (
                        <p className="text-red-500 text-sm mt-1">{errors.about}</p>
                      )}
                    </div>

                    <div>
                      <Label htmlFor="footerText">
                        {t('dashboard.organization.settings.footer_text')}
                        <span className="text-gray-500 text-sm ms-2">
                          {charsLeft(MAX_FOOTER_TEXT_LENGTH, footerText)}
                        </span>
                      </Label>
                      <Input
                        id="footerText"
                        name="footerText"
                        value={footerText}
                        onChange={(e) => setFooterText(e.target.value)}
                        placeholder={t('dashboard.organization.settings.footer_text_placeholder')}
                        maxLength={MAX_FOOTER_TEXT_LENGTH}
                      />
                      <p className="text-gray-500 text-sm mt-1">{t('dashboard.organization.settings.footer_text_desc')}</p>
                    </div>

                    <div>
                      <Label htmlFor="emailSenderName">
                        {t('dashboard.organization.settings.email_sender_name')}
                        <span className="text-gray-500 text-sm ms-2">
                          {charsLeft(MAX_EMAIL_SENDER_NAME_LENGTH, emailSenderName)}
                        </span>
                      </Label>
                      <Input
                        id="emailSenderName"
                        name="emailSenderName"
                        value={emailSenderName}
                        onChange={(e) => setEmailSenderName(e.target.value)}
                        placeholder={t('dashboard.organization.settings.email_sender_name_placeholder')}
                        maxLength={MAX_EMAIL_SENDER_NAME_LENGTH}
                      />
                      <p className="text-gray-500 text-sm mt-1">{t('dashboard.organization.settings.email_sender_name_desc')}</p>
                    </div>

                    <div>
                      <Label htmlFor="defaultLanguage">
                        {t('dashboard.organization.settings.default_language')}
                      </Label>
                      <Select
                        value={defaultLanguage}
                        onValueChange={setDefaultLanguage}
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {AVAILABLE_LANGUAGES.map((lang) => (
                            <SelectItem key={lang.code} value={lang.code}>
                              <span className="flex items-center space-x-2">
                                <span className="text-xs font-mono text-gray-400 w-6">{lang.code.toUpperCase()}</span>
                                <span>{lang.nativeName}</span>
                              </span>
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <p className="text-gray-500 text-sm mt-1">{t('dashboard.organization.settings.default_language_desc')}</p>
                    </div>

                  </div>
                </div>
              </div>
              <div className="flex flex-row-reverse mt-0 mx-5 mb-5">
                <Button 
                  type="submit" 
                  disabled={isSubmitting}
                  className="bg-black text-white hover:bg-black/90"
                >
                  {isSubmitting ? t('dashboard.organization.settings.saving') : t('dashboard.organization.settings.save_changes')}
                </Button>
              </div>
            </div>
          </Form>
        )}
      </Formik>
    </div>
  )
}

export default OrgEditGeneral
