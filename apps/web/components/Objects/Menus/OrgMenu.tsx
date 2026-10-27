'use client'
import React, { useEffect, useState } from 'react'
import CopilotBubble from '@components/Copilot/CopilotBubble'
import Link from 'next/link'
import { useQuery } from '@tanstack/react-query'
import { queryKeys } from '@/lib/query/keys'
import { getUriWithOrg } from '@services/config/config'
import { fetchRAGChatSessions, RAGChatSession } from '@services/ai/ai'
import { HeaderProfileBox } from '@components/Security/HeaderProfileBox'
import MenuLinks from './OrgMenuLinks'
import { useLHSession } from '@components/Contexts/LHSessionContext'
import { useOrg } from '@components/Contexts/OrgContext'
import { ArrowLeft } from 'lucide-react'
import ScWordmark from './ScWordmark'
import { getScSiteUrl } from './scBrand'
import { usePathname } from 'next/navigation'
import { useTranslation } from 'react-i18next'
import useAdminStatus from '@components/Hooks/useAdminStatus'
import {
  Question,
  Book,
  Globe,
  ChatCircleDots,
  ChatCircle,
  SquaresFour,
  ChalkboardSimple,
  Signpost,
} from '@phosphor-icons/react'
import { DiscordIcon } from '@components/Objects/Icons/DiscordIcon'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@components/ui/dropdown-menu"
import { FeedbackModal } from '@components/Objects/Modals/FeedbackModal'
import { DASHBOARD_MENU_ITEMS, DashboardMenuItem } from '@/lib/dashboard-menu-items'
import { isFeatureAvailable } from '@services/plans/plans'
import { getMenuColorClasses } from '@services/utils/ts/colorUtils'
import AuthenticatedClientElement from '@components/Security/AuthenticatedClientElement'
import { useJoinBannerVisible, JOIN_BANNER_HEIGHT } from '@components/Objects/Banners/OrgJoinBanner'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@components/ui/tooltip'
import { useLHAnalytics, AnalyticsEvent } from '@services/analytics'
import CartHeaderButton from '@components/Store/Cart/CartHeaderButton'

export const OrgMenu = (props: any) => {
  const orgslug = props.orgslug
  const session = useLHSession() as any;
  const _access_token = session?.data?.tokens?.access_token;
  const org = useOrg() as any;
  const [isFocusMode, setIsFocusMode] = useState(false)
  const pathname = usePathname()
  // Sanar y Criar: the mobile panel remembers the path it was opened on, so
  // any navigation (menu links, the profile dropdown) closes it.
  const [menuOpenPath, setMenuOpenPath] = React.useState<string | null>(null)
  const isMenuOpen = menuOpenPath !== null && menuOpenPath === pathname
  const setIsMenuOpen = (open: boolean) => setMenuOpenPath(open ? pathname : null)
  const { t } = useTranslation()
  const { rights } = useAdminStatus()
  const [feedbackModalOpen, setFeedbackModalOpen] = useState(false)
  const { isVisible: isJoinBannerVisible } = useJoinBannerVisible()
  const { track } = useLHAnalytics()

  // Copilot bubble state
  const [bubbleOpen, setBubbleOpen] = useState(false)
  const [bubbleSessionToLoad, setBubbleSessionToLoad] = useState<string | null>(null)
  const [isBubbleMode, setIsBubbleMode] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false
    const stored = localStorage.getItem('copilot-bubble-mode')
    return stored === 'true'
  })

  const toggleBubbleMode = (value: boolean) => {
    setIsBubbleMode(value)
    localStorage.setItem('copilot-bubble-mode', String(value))
    if (!value) setBubbleOpen(false)
  }

  const openBubbleWithSession = (sessionUuid?: string) => {
    if (sessionUuid) setBubbleSessionToLoad(sessionUuid)
    setBubbleOpen(true)
  }
  const topOffset = isJoinBannerVisible ? JOIN_BANNER_HEIGHT : 0

  const config = org?.config?.config
  // Sanar y Criar: the header always uses the brand palette; the org colour
  // (customization.general.color) only tints emails.
  const colors = getMenuColorClasses('')

  // Filter dashboard menu items by resolved_features from API
  const rf = config?.resolved_features
  const visibleDashboardItems = DASHBOARD_MENU_ITEMS.filter((item: DashboardMenuItem) => {
    if (!item.featureKey) return true
    if (rf?.[item.featureKey]) return rf[item.featureKey].enabled
    return isFeatureAvailable(item.featureKey)
  })

  useEffect(() => {
    // Only check focus mode if we're in an activity page
    if (typeof window !== 'undefined' && pathname?.includes('/activity/')) {
      const saved = localStorage.getItem('globalFocusMode');
      setIsFocusMode(saved === 'true');
    } else {
      setIsFocusMode(false);
    }

    // Add storage event listener for cross-window changes
    const handleStorageChange = (e: StorageEvent) => {
      if (e.key === 'globalFocusMode' && pathname?.includes('/activity/')) {
        setIsFocusMode(e.newValue === 'true');
      }
    };

    // Add custom event listener for same-window changes
    const handleFocusModeChange = (e: CustomEvent) => {
      if (pathname?.includes('/activity/')) {
        setIsFocusMode(e.detail.isFocusMode);
      }
    };

    window.addEventListener('storage', handleStorageChange);
    window.addEventListener('focusModeChange', handleFocusModeChange as EventListener);

    // Cleanup
    return () => {
      window.removeEventListener('storage', handleStorageChange);
      window.removeEventListener('focusModeChange', handleFocusModeChange as EventListener);
    };
  }, [pathname]);

  function toggleMenu() {
    setIsMenuOpen(!isMenuOpen)
  }

  // Only hide menu if we're in an activity page and focus mode is enabled
  if (pathname?.includes('/activity/') && isFocusMode) {
    return null;
  }

  return (
    <>
      <div className="h-[60px]" style={{ zIndex: 'var(--z-behind)', marginTop: topOffset }}></div>
      {/* Sanar y Criar: light brand bar (nube, borde) with the text wordmark,
          text links and "Volver al sitio", like the marketing site header.
          The org logo/colour and the search box are not shown here. */}
      <nav
        aria-label={t('sc_brand.nav_label', { defaultValue: 'Navegación principal' })}
        className="fixed start-0 end-0 h-[60px] border-b border-borde bg-nube/90 backdrop-blur-md supports-[backdrop-filter]:bg-nube/80"
        style={{
          zIndex: 'var(--z-nav)',
          top: topOffset
        }}
      >
        <div className="flex items-center justify-between gap-4 w-full max-w-(--breakpoint-2xl) mx-auto px-4 sm:px-6 lg:px-8 h-full">
          <div className="flex items-center gap-8 min-w-0 overflow-hidden p-1 -m-1">
            <Link
              href={getUriWithOrg(orgslug, '/')}
              className="shrink-0 rounded-md"
              aria-label={t('sc_brand.home_label', { defaultValue: 'Sanar y Criar, inicio' })}
            >
              <ScWordmark />
            </Link>
            <div className="hidden md:flex">
              <MenuLinks orgslug={orgslug} />
            </div>
          </div>

          <div className="flex items-center gap-1.5">
            <a
              href={getScSiteUrl()}
              className="hidden lg:inline-flex items-center gap-1.5 me-2 whitespace-nowrap text-[0.875rem] font-medium text-violeta-500 underline-offset-[0.4em] decoration-rosa-300 decoration-2 hover:text-violeta hover:underline"
            >
              <ArrowLeft size={15} strokeWidth={1.75} aria-hidden="true" />
              {t('sc_brand.back_to_site', { defaultValue: 'Volver al sitio' })}
            </a>
            {/* Progress / Trail */}
            <AuthenticatedClientElement checkMethod="authentication">
              <div className="hidden md:flex">
                <TooltipProvider delayDuration={0}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Link
                        href={getUriWithOrg(orgslug, '/trail')}
                        className={`p-2 rounded-lg transition-colors ${colors.iconBtn}`}
                        aria-label={t('courses.progress')}
                      >
                        <Signpost size={20} weight="regular" />
                      </Link>
                    </TooltipTrigger>
                    <TooltipContent side="bottom" className="text-xs">
                      {t('courses.progress')}
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              </div>
            </AuthenticatedClientElement>
            {/* Boards (Sanar y Criar: staff only; learners see courses and the store) */}
            {rf?.boards?.enabled && rights?.dashboard?.action_access && (
              <AuthenticatedClientElement checkMethod="authentication">
                <div className="hidden md:flex">
                  <TooltipProvider delayDuration={0}>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Link
                          href={getUriWithOrg(orgslug, '/boards')}
                          className={`p-2 rounded-lg transition-colors ${colors.iconBtn}`}
                          aria-label="Boards"
                        >
                          <ChalkboardSimple size={20} weight="regular" />
                        </Link>
                      </TooltipTrigger>
                      <TooltipContent side="bottom" className="text-xs">
                        Boards
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                </div>
              </AuthenticatedClientElement>
            )}
            {/* AI Copilot */}
            {rf?.ai?.enabled && config?.admin_toggles?.ai?.copilot_enabled !== false && rights?.dashboard?.action_access && (
              <AuthenticatedClientElement checkMethod="authentication">
                <div className="hidden md:flex">
                  <CopilotMenuButton
                    orgslug={orgslug}
                    iconBtnClass={colors.iconBtn}
                    isBubbleMode={isBubbleMode}
                    onToggleBubbleMode={toggleBubbleMode}
                    bubbleOpen={bubbleOpen}
                    onOpenBubble={openBubbleWithSession}
                  />
                </div>
              </AuthenticatedClientElement>
            )}
            {/* Dashboard Dropdown - Only visible to admins */}
            {session?.status === 'authenticated' && rights?.dashboard?.action_access && (
              <div className="hidden md:flex">
                <DropdownMenu>
                  <TooltipProvider delayDuration={0}>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <DropdownMenuTrigger asChild>
                          <button
                            className={`p-2 rounded-lg transition-colors ${colors.iconBtn}`}
                            aria-label={t('common.dashboard')}
                          >
                            <SquaresFour size={20} weight="regular" />
                          </button>
                        </DropdownMenuTrigger>
                      </TooltipTrigger>
                      <TooltipContent side="bottom" className="text-xs">
                        {t('common.dashboard')}
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                  <DropdownMenuContent align="end" className="w-56">
                    <DropdownMenuLabel className="flex items-center gap-2">
                      <SquaresFour size={16} weight="fill" />
                      <span>{t('common.dashboard')}</span>
                    </DropdownMenuLabel>
                    <DropdownMenuSeparator />
                    {visibleDashboardItems.map((item) => {
                      const IconComponent = item.icon
                      return (
                        <DropdownMenuItem key={item.id} asChild>
                          <Link
                            href={item.href}
                            className="flex items-center gap-2"
                            onClick={() => track(AnalyticsEvent.DashboardEntered, { source: 'org_menu' })}
                          >
                            <IconComponent size={16} weight="fill" />
                            <span>{t(item.labelKey)}</span>
                          </Link>
                        </DropdownMenuItem>
                      )
                    })}
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            )}

            {/* Help Dropdown - Only visible to admins/maintainers/instructors */}
            {session?.status === 'authenticated' && rights?.dashboard?.action_access && (
              <div className="hidden md:flex">
                <DropdownMenu>
                  <TooltipProvider delayDuration={0}>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <DropdownMenuTrigger asChild>
                          <button
                            className={`p-2 rounded-lg transition-colors ${colors.iconBtn}`}
                            aria-label={t('common.help')}
                          >
                            <Question size={20} weight="regular" />
                          </button>
                        </DropdownMenuTrigger>
                      </TooltipTrigger>
                      <TooltipContent side="bottom" className="text-xs">
                        {t('common.help')}
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                  <DropdownMenuContent align="end" className="w-56">
                    <DropdownMenuLabel className="flex items-center gap-2">
                      <Question size={16} weight="fill" />
                      <span>{t('common.help')}</span>
                    </DropdownMenuLabel>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem asChild>
                      <a
                        href="https://docs.learnhouse.app"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center gap-2"
                      >
                        <Book size={16} weight="fill" />
                        <span>{t('common.help_menu.documentation')}</span>
                      </a>
                    </DropdownMenuItem>
                    <DropdownMenuItem asChild>
                      <a
                        href="https://learnhouse.app"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center gap-2"
                      >
                        <Globe size={16} weight="fill" />
                        <span>{t('common.help_menu.website')}</span>
                      </a>
                    </DropdownMenuItem>
                    <DropdownMenuItem asChild>
                      <a
                        href="http://learnhouse.to/discord"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center gap-2"
                      >
                        <DiscordIcon size={16} />
                        <span>{t('common.help_menu.discord')}</span>
                      </a>
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      onClick={() => setFeedbackModalOpen(true)}
                      className="flex items-center gap-2"
                    >
                      <ChatCircleDots size={16} weight="fill" />
                      <span>{t('common.help_menu.report_feedback')}</span>
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            )}

            {/* Sanar y Criar: cart, only when it has something (also on phones) */}
            <CartHeaderButton orgslug={orgslug} />
            <div className="hidden md:flex">
              <HeaderProfileBox />
            </div>
            <button
              type="button"
              className="md:hidden inline-flex h-11 w-11 items-center justify-center rounded-full text-violeta hover:bg-lavanda-100"
              onClick={toggleMenu}
              aria-expanded={isMenuOpen}
              aria-controls="sc-mobile-menu"
              aria-label={isMenuOpen
                ? t('sc_brand.close_menu', { defaultValue: 'Cerrar menú' })
                : t('sc_brand.open_menu', { defaultValue: 'Abrir menú' })}
            >
              {isMenuOpen ? (
                <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              ) : (
                <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
                </svg>
              )}
            </button>
          </div>
        </div>
      </nav>
      {isMenuOpen && (
        <div
          id="sc-mobile-menu"
          className="fixed inset-x-0 border-b border-borde bg-nube md:hidden shadow-lg shadow-violeta/5"
          style={{
            zIndex: 'var(--z-nav-menu)',
            top: topOffset + 60
          }}
        >
          <nav
            aria-label={t('sc_brand.mobile_nav_label', { defaultValue: 'Menú móvil' })}
            className="flex flex-col px-4 pt-2 pb-6"
          >
            <MenuLinks orgslug={orgslug} variant="mobile" onNavigate={() => setIsMenuOpen(false)} />
            <CartHeaderButton orgslug={orgslug} variant="mobile" onNavigate={() => setIsMenuOpen(false)} />
            <AuthenticatedClientElement checkMethod="authentication">
              <Link
                href={getUriWithOrg(orgslug, '/trail')}
                onClick={() => setIsMenuOpen(false)}
                className="flex min-h-12 items-center border-t border-borde py-3 text-base font-medium text-violeta-600"
              >
                {t('courses.progress')}
              </Link>
            </AuthenticatedClientElement>
            <a
              href={getScSiteUrl()}
              className="flex min-h-12 items-center gap-2 border-t border-borde py-3 text-base font-medium text-violeta-600"
            >
              <ArrowLeft size={16} strokeWidth={1.75} aria-hidden="true" />
              {t('sc_brand.back_to_site', { defaultValue: 'Volver al sitio' })}
            </a>
            <div className="mt-4">
              <HeaderProfileBox variant="mobile" />
            </div>
          </nav>
        </div>
      )}

      {/* Feedback Modal */}
      <FeedbackModal
        open={feedbackModalOpen}
        onOpenChange={setFeedbackModalOpen}
        theme="light"
        userName={session?.data?.user?.username}
        userEmail={session?.data?.user?.email}
      />

      {/* Copilot floating bubble */}
      {isBubbleMode && (
        <CopilotBubble
          orgslug={orgslug}
          open={bubbleOpen}
          onOpenChange={setBubbleOpen}
          sessionToLoad={bubbleSessionToLoad}
        />
      )}
    </>
  )
}

const CopilotMenuButton = ({
  orgslug,
  isBubbleMode,
  onToggleBubbleMode,
  bubbleOpen,
  onOpenBubble,
}: {
  orgslug: string
  iconBtnClass: string
  isBubbleMode: boolean
  onToggleBubbleMode: (_v: boolean) => void
  bubbleOpen: boolean
  onOpenBubble: (_sessionUuid?: string) => void
}) => {
  const session = useLHSession() as any
  const accessToken = session?.data?.tokens?.access_token
  const [isOpen, setIsOpen] = useState(false)

  // Only fetch when the dropdown is open; avoids firing on every page load
  const { data: sessions } = useQuery<RAGChatSession[]>({
    queryKey: queryKeys.ai.ragSessions(orgslug),
    queryFn: () => fetchRAGChatSessions(accessToken, orgslug),
    enabled: isOpen && !!accessToken && !!orgslug,
    staleTime: 60_000,
  })

  const recentSessions = (sessions || []).slice(0, 5)

  return (
    <DropdownMenu onOpenChange={setIsOpen}>
      <TooltipProvider delayDuration={0}>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <button
                className="relative p-2 rounded-lg transition-colors hover:bg-violet-500/10"
                aria-label="Copilot"
              >
                <ChatCircle size={20} weight="regular" className="text-violet-500" />
                {/* Active indicator dot */}
                {isBubbleMode && bubbleOpen && (
                  <span className="absolute top-1.5 end-1.5 w-2 h-2 rounded-full bg-violet-500 ring-2 ring-white dark:ring-neutral-900" />
                )}
              </button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="text-xs">
            Copilot
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>

      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel className="flex items-center gap-2">
          <ChatCircle size={16} weight="fill" className="text-violet-500" />
          <span>Copilot</span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />

        {recentSessions.length > 0 ? (
          <>
            {recentSessions.map((s) => (
              isBubbleMode ? (
                <DropdownMenuItem
                  key={s.aichat_uuid}
                  onSelect={() => onOpenBubble(s.aichat_uuid)}
                  className="flex items-center gap-2 cursor-pointer"
                >
                  <ChatCircleDots size={14} weight="fill" className="shrink-0 text-neutral-400" />
                  <span className="truncate text-sm">{s.title || 'Untitled'}</span>
                </DropdownMenuItem>
              ) : (
                <DropdownMenuItem key={s.aichat_uuid} asChild>
                  <Link href={getUriWithOrg(orgslug, `/copilot?chat=${s.aichat_uuid}`)} className="flex items-center gap-2">
                    <ChatCircleDots size={14} weight="fill" className="shrink-0 text-neutral-400" />
                    <span className="truncate text-sm">{s.title || 'Untitled'}</span>
                  </Link>
                </DropdownMenuItem>
              )
            ))}
            <DropdownMenuSeparator />
          </>
        ) : (
          <div className="px-2 py-3 text-center">
            <p className="text-xs text-neutral-400">No conversations yet</p>
          </div>
        )}

        {/* Primary action */}
        {isBubbleMode ? (
          <DropdownMenuItem
            onSelect={() => onOpenBubble()}
            className="flex items-center gap-2 font-medium cursor-pointer"
          >
            <ChatCircle size={14} weight="fill" className="text-violet-500" />
            <span>{recentSessions.length > 0 ? 'New conversation' : 'Start a conversation'}</span>
          </DropdownMenuItem>
        ) : (
          <DropdownMenuItem asChild>
            <Link href={getUriWithOrg(orgslug, '/copilot')} className="flex items-center gap-2 font-medium">
              <ChatCircle size={14} weight="fill" className="text-violet-500" />
              <span>{recentSessions.length > 0 ? 'View all conversations' : 'Start a conversation'}</span>
            </Link>
          </DropdownMenuItem>
        )}

        <DropdownMenuSeparator />

        {/* Bubble mode toggle */}
        <button
          onClick={() => onToggleBubbleMode(!isBubbleMode)}
          className="w-full flex items-center justify-between px-2 py-2 rounded-md hover:bg-neutral-50 dark:hover:bg-neutral-800 transition-colors group"
        >
          <span className="text-xs text-neutral-500 group-hover:text-neutral-700 dark:group-hover:text-neutral-300 transition-colors">
            Open in bubble
          </span>
          <span
            className={`relative inline-flex h-4 w-7 items-center rounded-full transition-colors flex-shrink-0 ${
              isBubbleMode ? 'bg-violet-500' : 'bg-neutral-200 dark:bg-neutral-600'
            }`}
          >
            <span
              className={`inline-block h-3 w-3 rounded-full bg-white shadow-sm transition-transform ${
                isBubbleMode ? 'translate-x-3.5 rtl:-translate-x-3.5' : 'translate-x-0.5 rtl:-translate-x-0.5'
              }`}
            />
          </span>
        </button>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
