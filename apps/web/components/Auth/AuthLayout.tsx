'use client'
import React from 'react'
import AuthBrandingPanel from '@components/Auth/AuthBrandingPanel'
import AuthMobileHeader from '@components/Auth/AuthMobileHeader'
import { AuthFooter } from '@components/Footers/LegalFooters'

interface AuthLayoutProps {
  org: any
  welcomeText?: string
  // No-org (apex) branding copy: platform-style title + subtitle.
  title?: string
  subtitle?: string
  children: React.ReactNode
}

export default function AuthLayout({ org, welcomeText, title, subtitle, children }: AuthLayoutProps) {
  return (
    // Sanar y Criar: nube page with soft watercolor corners instead of the
    // blueprint grid, no language switcher (Spanish only). `sc-auth` gives the
    // forms the brand shapes (pill buttons, 12px fields; see globals.css).
    <div className="sc-auth sc-watercolor min-h-screen lg:h-screen bg-nube flex flex-col lg:flex-row relative overflow-hidden">

      {/* Mobile Header - visible only on small screens */}
      <div className="lg:hidden relative z-10">
        <AuthMobileHeader org={org} />
      </div>

      {/* Left Panel - Content / form */}
      <div className="relative z-10 flex flex-col flex-1 lg:h-full overflow-auto bg-transparent">
        <div className="flex-1 flex flex-col">{children}</div>
        {/* Terms footer (platform-style) */}
        <AuthFooter className="shrink-0" />
      </div>

      {/* Right Panel - Branding (hidden on mobile) */}
      <div className="hidden lg:block w-[48%] relative z-10 shrink-0">
        <AuthBrandingPanel
          org={org}
          welcomeText={welcomeText}
          title={title}
          subtitle={subtitle}
        />
      </div>
    </div>
  )
}
