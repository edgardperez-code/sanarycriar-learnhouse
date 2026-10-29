import '../styles/globals.css'
import React from 'react'
import type { Metadata, Viewport } from 'next'
import Providers from '@components/Providers'
import { Poppins, Playfair_Display, Tajawal } from 'next/font/google'

// Sanar y Criar: brand typography (brand manual p.1). Poppins for everything,
// Playfair Display for titles, phrases and big numbers. `--font-default` keeps
// the upstream variable name so every existing rule picks Poppins up.
const poppins = Poppins({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  display: 'swap',
  variable: '--font-default',
})

const playfairDisplay = Playfair_Display({
  subsets: ['latin'],
  weight: ['500', '600'],
  style: ['normal', 'italic'],
  display: 'swap',
  variable: '--font-heading',
})

// Poppins has no Arabic subset, so Arabic would otherwise fall back to
// whatever the OS provides (Geeza Pro, Segoe UI, Noto) and look like a
// different product on every platform.
//
// Tajawal is the Arabic face for the whole product. It is FORCED whenever the
// UI is Arabic (see globals.css), not merely offered as a fallback: Tajawal
// ships a Latin subset too, so a mixed Arabic screen renders in one typeface
// instead of switching per glyph between two designs with different
// proportions.
//
// Weights are 200-900 with no 600, so a `font-semibold` element rounds up to 700,
// which is the intended reading.
const tajawal = Tajawal({
  subsets: ['arabic', 'latin'],
  weight: ['300', '400', '500', '700', '800'],
  display: 'swap',
  variable: '--font-arabic',
  // Sanar y Criar: the UI is Spanish only; don't preload a face nobody uses.
  preload: false,
})

// Sanar y Criar: brand icons (the round pink icon of the marketing site). An
// org favicon uploaded from the dashboard still wins (app/orgs/[orgslug]/layout.tsx).
export const metadata: Metadata = {
  icons: {
    icon: [
      { url: '/favicon.ico?v=2', sizes: '16x16 32x32 48x48' },
      { url: '/sc-icon-192.png?v=2', sizes: '192x192', type: 'image/png' },
    ],
    apple: '/sc-apple-touch-icon.png?v=2',
  },
}

export const viewport: Viewport = {
  themeColor: '#FDF5EE',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  // `dir` is deliberately absent from the <html> below. React only reconciles
  // attributes present in its virtual tree, so leaving it out means React never
  // clobbers what dir-init.js wrote before paint. `lang` is the no-JS baseline
  // for crawlers; the script overwrites it for everyone else.
  // Sanar y Criar: Spanish is the platform language.
  return (
    <html
      className={`${poppins.variable} ${playfairDisplay.variable} ${tajawal.variable}`}
      lang="es"
      suppressHydrationWarning
    >
      <head>
        {/* Synchronous script: sets <html lang/dir> before body paints so an
            RTL locale never flashes an LTR layout. Must run first. */}
        {/* eslint-disable-next-line @next/next/no-sync-scripts */}
        <script src="/dir-init.js" />
        {/* Synchronous script: blocks parsing to guarantee window.__RUNTIME_CONFIG__ exists before any JS runs.
            Next.js <Script strategy="beforeInteractive"> is not truly blocking in all browsers (Safari). */}
        {/* eslint-disable-next-line @next/next/no-sync-scripts */}
        <script src="/runtime-config.js" />
        {/* Prevent white flash on embed routes: set html+body bg before body is painted.
            Reads the optional ?bgcolor param (hex-validated) or defaults to dark. */}
        {/* eslint-disable-next-line @next/next/no-sync-scripts */}
        <script src="/embed-bg.js" />
      </head>
      <body suppressHydrationWarning>
        <Providers>
          <main className="animate-fade-in">
            {children}
          </main>
        </Providers>
      </body>
    </html>
  )
}
