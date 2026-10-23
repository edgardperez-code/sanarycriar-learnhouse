'use client'
import React, { use } from 'react';
import { motion } from 'motion/react'
import { Breadcrumbs } from '@components/Objects/Breadcrumbs/Breadcrumbs'
import Link from 'next/link'
import { getUriWithOrg } from '@services/config/config'
import { Settings, Users, Gem, CreditCard, Layers, ShoppingBag, ExternalLink } from 'lucide-react'
import { SiPaypal } from '@icons-pack/react-simple-icons'
import { useQuery } from '@tanstack/react-query'
import { useLHSession } from '@components/Contexts/LHSessionContext'
import { useOrg } from '@components/Contexts/OrgContext'
import PaymentsConfigurationPage from '@components/Dashboard/Pages/Payments/PaymentsConfigurationPage'
import PaymentsCustomersPage from '@components/Dashboard/Pages/Payments/PaymentsCustomersPage'
import PaymentsOffersPage from '@components/Dashboard/Pages/Payments/PaymentsOffersPage'
import PaymentsGroupsPage from '@components/Dashboard/Pages/Payments/PaymentsGroupsPage'
import FeatureGate from '@components/Dashboard/Shared/FeatureGate/FeatureGate'
import { DashTabBar, DashTabItem } from '@components/Dashboard/Shared/DashTabBar/DashTabBar'
import { queryKeys } from '@/lib/query/keys'
import { getPaymentConfigs } from '@services/payments/payments'
import { useScT } from '@components/Payments/useScT'
import { providerDashboardUrl, providerLabel } from '@components/Payments/commerce'

export type PaymentsParams = {
  subpage: string
  orgslug: string
}

function PaymentsPage(props: { params: Promise<PaymentsParams> }) {
  const params = use(props.params);
  const session = useLHSession() as any
  const org = useOrg() as any
  const { sc } = useScT()
  const accessToken = session?.data?.tokens?.access_token
  const subpage = params.subpage || 'overview'
  const getPageTitle = () => {
    switch (subpage) {
      case 'overview':
      case 'customers':
        return { h1: sc('dash.overview_title'), h2: sc('dash.overview_subtitle') }
      case 'offers':
        return { h1: sc('dash.offers_title'), h2: sc('dash.offers_subtitle') }
      case 'groups':
        return { h1: sc('dash.groups_title'), h2: sc('dash.groups_subtitle') }
      case 'configuration':
        return { h1: sc('dash.configuration_title'), h2: sc('dash.configuration_subtitle') }
      default:
        return { h1: sc('dash.payments_title'), h2: sc('dash.payments_subtitle') }
    }
  }

  const { h1, h2 } = getPageTitle()
  const paymentsEnabled = org?.config?.config?.resolved_features?.payments?.enabled ?? org?.config?.config?.features?.payments?.enabled !== false

  // Sanar y Criar: the OSS "Gate 1" that blocked payments entirely is gone;
  // our own payments module backs this dashboard. FeatureGate below still
  // honours the org's admin toggle.

  // Sanar y Criar: provider-aware dashboard link (same cache entry as the
  // configuration page and usePaymentsEnabled).
  const { data: configs } = useQuery({
    queryKey: queryKeys.payments.configs(org?.id),
    queryFn: () => getPaymentConfigs(org.id, accessToken),
    enabled: !!(org?.id && accessToken),
    staleTime: 60_000,
  })
  const activeConfig = Array.isArray(configs) ? configs.find((c: any) => c?.active) : null
  const dashboardUrl = activeConfig
    ? providerDashboardUrl(activeConfig.provider, activeConfig.settings?.environment)
    : null

  const tabs: DashTabItem[] = [
    {
      key: 'overview',
      label: sc('dash.tab_overview'),
      icon: <Users size={16} />,
      href: getUriWithOrg(params.orgslug, '/dash/payments/overview'),
      active: subpage === 'overview' || subpage === 'customers',
    },
    {
      key: 'offers',
      label: sc('dash.tab_offers'),
      icon: <Gem size={16} />,
      href: getUriWithOrg(params.orgslug, '/dash/payments/offers'),
      active: subpage === 'offers',
    },
    {
      key: 'groups',
      label: sc('dash.tab_groups'),
      icon: <Layers size={16} />,
      href: getUriWithOrg(params.orgslug, '/dash/payments/groups'),
      active: subpage === 'groups',
    },
    {
      key: 'configuration',
      label: sc('dash.tab_configuration'),
      icon: <Settings size={16} />,
      href: getUriWithOrg(params.orgslug, '/dash/payments/configuration'),
      active: subpage === 'configuration',
    },
  ]

  return (
    <FeatureGate feature="payments">
    <div className="h-screen w-full bg-[#f8f8f8] flex flex-col">
      <div className="ps-4 pe-4 sm:ps-10 sm:pe-10 tracking-tight bg-[#fcfbfc] z-10 nice-shadow flex-shrink-0 relative">
        <div className="pt-6 pb-4">
          <Breadcrumbs items={[
            { label: sc('dash.breadcrumb'), href: '/dash/payments', icon: <CreditCard size={14} /> }
          ]} />
        </div>
        <div className="my-2 py-2 flex flex-wrap gap-2 items-end justify-between">
          <div className="flex flex-col space-y-1 min-w-0">
            <div className="pt-3 flex font-bold text-3xl sm:text-4xl tracking-tighter truncate">
              {h1}
            </div>
            <div className="flex font-medium text-gray-400 text-md sm:truncate">
              {h2}
            </div>
          </div>
          {/* Sanar y Criar: max-w-full lets the pills wrap inside the header on
              phones instead of pushing the page sideways (shrink-0 kept their
              single-line width). */}
          <div className="flex items-center gap-2 pb-1 shrink-0 flex-wrap max-w-full">
            {paymentsEnabled && (
              <Link
                href={getUriWithOrg(params.orgslug, '/store')}
                target="_blank"
                className="flex items-center space-x-2 px-3 py-1.5 rounded-full border border-[#EAE8F2] bg-white text-sm font-medium text-[#190933] hover:bg-[#EEEDFF] transition-colors"
              >
                <ShoppingBag size={14} />
                <span>{sc('dash.preview_store')}</span>
                <ExternalLink size={12} className="text-gray-400" />
              </Link>
            )}
            {dashboardUrl && (
              <a
                href={dashboardUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center space-x-2 px-3 py-1.5 rounded-full border border-[#EAE8F2] bg-white text-sm font-medium text-[#190933] hover:bg-[#EEEDFF] transition-colors"
              >
                <SiPaypal size={14} className="text-[#003087]" />
                <span>
                  {sc('dash.provider_dashboard', { provider: providerLabel(activeConfig?.provider, sc) })}
                  {activeConfig?.settings?.environment !== 'live' ? ` (${sc('config.env_sandbox')})` : ''}
                </span>
                <ExternalLink size={12} className="text-gray-400" />
              </a>
            )}
          </div>
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
        {subpage === 'configuration' && <PaymentsConfigurationPage />}
        {subpage === 'offers' && <PaymentsOffersPage />}
        {subpage === 'groups' && <PaymentsGroupsPage />}
        {(subpage === 'overview' || subpage === 'customers') && <PaymentsCustomersPage />}
        {/* Sanar y Criar: room after the content for the floating mobile dock,
            which otherwise covers the last button ("Nueva oferta", …). A
            spacer, not padding: the pages are h-full and overflow it. */}
        <div aria-hidden className="h-24 lg:hidden" />
      </motion.div>
    </div>
    </FeatureGate>
  )
}

export default PaymentsPage
