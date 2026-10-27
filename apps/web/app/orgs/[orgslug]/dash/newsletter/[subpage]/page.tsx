'use client'
// Sanar y Criar: newsletter section of the dashboard. "popup" edits the
// sign-up pop-up of the marketing site; "subscribers" lists the emails. No
// FeatureGate: the section is always available and the API enforces the
// org-admin permission.
import React, { use } from 'react'
import { motion } from 'motion/react'
import { Breadcrumbs } from '@components/Objects/Breadcrumbs/Breadcrumbs'
import { getUriWithOrg } from '@services/config/config'
import { ExternalLink, Mail, MessageSquareText, Send, Users } from 'lucide-react'
import { DashTabBar, DashTabItem } from '@components/Dashboard/Shared/DashTabBar/DashTabBar'
import NewsletterPopupPage from '@components/Dashboard/Pages/Newsletter/NewsletterPopupPage'
import NewsletterSubscribersPage from '@components/Dashboard/Pages/Newsletter/NewsletterSubscribersPage'
import { useNewsletterT } from '@components/Dashboard/Pages/Newsletter/useNewsletterT'
import { useNewsletterSettings } from '@components/Dashboard/Pages/Newsletter/useNewsletterSettings'

export type NewsletterParams = {
  subpage: string
  orgslug: string
}

function NewsletterPage(props: { params: Promise<NewsletterParams> }) {
  const params = use(props.params)
  const { nl } = useNewsletterT()
  // Same cache entry as the pop-up tab; only used for the Resend button here.
  const { data: settings } = useNewsletterSettings()

  // Unknown sub-pages fall back to the pop-up settings.
  const subpage: 'popup' | 'subscribers' = params.subpage === 'subscribers' ? 'subscribers' : 'popup'
  const { h1, h2 } =
    subpage === 'subscribers'
      ? { h1: nl('subscribers_title'), h2: nl('subscribers_subtitle') }
      : { h1: nl('popup_title'), h2: nl('popup_subtitle') }

  const tabs: DashTabItem[] = [
    {
      key: 'popup',
      label: nl('tab_popup'),
      icon: <MessageSquareText size={16} />,
      href: getUriWithOrg(params.orgslug, '/dash/newsletter/popup'),
      active: subpage === 'popup',
    },
    {
      key: 'subscribers',
      label: nl('tab_subscribers'),
      icon: <Users size={16} />,
      href: getUriWithOrg(params.orgslug, '/dash/newsletter/subscribers'),
      active: subpage === 'subscribers',
    },
  ]

  return (
    <div className="h-screen w-full bg-[#f8f8f8] flex flex-col">
      <div className="ps-4 pe-4 sm:ps-10 sm:pe-10 tracking-tight bg-[#fcfbfc] z-10 nice-shadow flex-shrink-0 relative">
        <div className="pt-6 pb-4">
          <Breadcrumbs items={[{ label: nl('breadcrumb'), href: '/dash/newsletter/popup', icon: <Mail size={14} /> }]} />
        </div>
        <div className="my-2 py-2 flex flex-wrap gap-2 items-end justify-between">
          <div className="flex flex-col space-y-1 min-w-0">
            <div className="pt-3 flex font-bold text-3xl sm:text-4xl tracking-tighter truncate">{h1}</div>
            <div className="flex font-medium text-gray-400 text-md sm:truncate">{h2}</div>
          </div>
          {settings?.resend_enabled && (
            <div className="flex items-center gap-2 pb-1 shrink-0 flex-wrap max-w-full">
              <a
                href="https://resend.com/broadcasts"
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center space-x-2 px-3 py-1.5 rounded-full border border-[#EAE8F2] bg-white text-sm font-medium text-[#190933] hover:bg-[#EEEDFF] transition-colors"
              >
                <Send size={14} />
                <span>{nl('open_resend')}</span>
                <ExternalLink size={12} className="text-gray-400" />
              </a>
            </div>
          )}
        </div>
        <DashTabBar tabs={tabs} />
      </div>
      <div className="h-6 flex-shrink-0"></div>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.1, type: 'spring', stiffness: 80 }}
        className="flex-1 overflow-y-auto"
      >
        {subpage === 'popup' && <NewsletterPopupPage />}
        {subpage === 'subscribers' && <NewsletterSubscribersPage />}
        {/* Room after the content for the floating mobile dock. */}
        <div aria-hidden className="h-24 lg:hidden" />
      </motion.div>
    </div>
  )
}

export default NewsletterPage
