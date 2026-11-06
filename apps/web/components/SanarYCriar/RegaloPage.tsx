'use client'
// Sanar y Criar: /regalo (contract "regalo" §B1), where the parenting test
// result and the free ebook land after signing up. Four states (regalo.ts):
//  - verified: the result, «Leer mi guía», and the reader joins the
//    newsletter once (POST newsletter/{org}/subscribe/me; remembered per
//    reader and origin, errors and rate limits stay silent); once she is on
//    the list the card says so in one line;
//  - unverified (login does not require a verified email): the result and
//    "activate your account", with resend and «Ya lo verifiqué»;
//  - pending (this tab just signed up, see the sign-up mark): the result and
//    "we sent you an email";
//  - gate (anyone else): "create your free account to see it", no result.
import React, { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import Link from 'next/link'
import { ArrowRight, BookOpen, Gift, LogIn, Mail, RefreshCw, UserPlus } from 'lucide-react'
import { SiWhatsapp } from '@icons-pack/react-simple-icons'
import GeneralWrapperStyled from '@components/Objects/StyledElements/Wrappers/GeneralWrapper'
import { useLHSession } from '@components/Contexts/LHSessionContext'
import { useCheckoutProviders } from '@components/Payments/useCheckoutProviders'
import { getScSiteUrl } from '@components/Objects/Menus/scBrand'
import { getUriWithOrg } from '@services/config/config'
import { resendVerificationEmail } from '@services/auth/auth'
import { subscribeMeToNewsletter } from '@services/newsletter/subscribeMe'
import { formatCurrency } from '@/lib/format'
import { rememberReturnPath } from './freeAccessGate'
import { useLearningT, type LearningTranslate } from './useLearningT'
import {
  REGALO_PATH,
  type RegaloOffer,
  type RegaloParams,
  type RegaloResultado,
  type RegaloView,
  type SignupMark,
  accentParts,
  buyHref,
  citaWhatsappUrl,
  guiaHref,
  offerHref,
  readSignupMark,
  regaloAuthHref,
  regaloPath,
  regaloView,
  rememberSubscribed,
  showsResult,
  subscribedKey,
  wasSubscribed,
} from './regalo'

interface RegaloPageProps {
  orgslug: string
  orgId: number
  params: RegaloParams
  /** Price of the featured offer (public listing), or null. */
  offer: RegaloOffer | null
  /** False when the org does not sell: no price and no purchase links. */
  storeEnabled: boolean
}

// In-page target of «Prefiero empezar por lo gratis» and similar links.
const GIFT_ID = 'tu-regalo'

// sessionStorage has no change event within the tab: nothing to subscribe to.
const noopSubscribe = () => () => {}

/** Text with its *accent* word in italics: lavanda-500 in titles (large text), a darker lavender in body copy. */
function Accented({ text, accentClassName = 'sc-title-accent' }: { text: string; accentClassName?: string }) {
  return (
    <>
      {accentParts(text).map((part, i) =>
        part.accent ? (
          <em key={i} className={accentClassName}>
            {part.text}
          </em>
        ) : (
          <React.Fragment key={i}>{part.text}</React.Fragment>
        )
      )}
    </>
  )
}

// ---------------------------------------------------------------------------
// The test result
// ---------------------------------------------------------------------------

function ResultSection({
  resultado,
  lt,
  readHref,
  buyLink,
  offerLink,
  price,
}: {
  resultado: RegaloResultado
  lt: LearningTranslate
  /** The free ebook, only once the account is verified. */
  readHref: string | null
  buyLink: string | null
  offerLink: string | null
  price: string | null
}) {
  const giftAnchor = `#${GIFT_ID}`
  let actions: React.ReactNode
  let links: React.ReactNode = null

  if (resultado === 'guia') {
    actions = readHref ? (
      <Link href={readHref} prefetch={false} className="sc-btn sc-btn-primary w-full sm:w-auto">
        <BookOpen size={18} strokeWidth={1.75} aria-hidden="true" />
        {lt('regalo.result.guia.cta')}
      </Link>
    ) : (
      <a href={giftAnchor} className="sc-btn sc-btn-primary w-full sm:w-auto">
        <Gift size={18} strokeWidth={1.75} aria-hidden="true" />
        {lt('regalo.result.guia.cta')}
      </a>
    )
    if (offerLink) {
      links = (
        <Link href={offerLink} prefetch={false} className="sc-link">
          {lt('regalo.result.guia.more')}
        </Link>
      )
    }
  } else if (resultado === 'limites') {
    actions = buyLink ? (
      <Link href={buyLink} prefetch={false} className="sc-btn sc-btn-primary w-full sm:w-auto">
        {price ? lt('regalo.result.limites.cta_price', { price }) : lt('regalo.result.limites.cta')}
      </Link>
    ) : null
    links = (
      <>
        {offerLink && (
          <Link href={offerLink} prefetch={false} className="sc-link">
            {lt('regalo.result.limites.details')}
          </Link>
        )}
        <a href={giftAnchor} className="sc-link">
          {lt('regalo.result.limites.free_first')}
        </a>
      </>
    )
  } else {
    actions = (
      <a href={citaWhatsappUrl()} target="_blank" rel="noopener noreferrer" className="sc-btn sc-btn-primary w-full sm:w-auto">
        <SiWhatsapp size={18} aria-hidden="true" />
        {lt('regalo.result.cita.cta')}
        <span className="sr-only"> {lt('regalo.result.new_tab')}</span>
      </a>
    )
    links = (
      <a href={giftAnchor} className="sc-link">
        {lt('regalo.result.cita.free_meanwhile')}
      </a>
    )
  }

  return (
    <section aria-labelledby="regalo-result-title">
      <p className="sc-eyebrow">{lt(`regalo.result.${resultado}.badge`)}</p>
      <h1 id="regalo-result-title" className="mt-3 text-[1.875rem] leading-[1.15] font-semibold text-violeta sm:text-[2.5rem]">
        <Accented text={lt(`regalo.result.${resultado}.title`)} />
      </h1>
      <p className="mt-4 text-[1.0625rem] leading-relaxed text-violeta-600">{lt(`regalo.result.${resultado}.text`)}</p>
      {actions && <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:flex-wrap">{actions}</div>}
      {links && <div className="mt-4 flex flex-col items-start gap-2.5 text-[0.9375rem]">{links}</div>}
      <p className="mt-8 border-t border-borde pt-4 text-sm leading-relaxed text-violeta-400">
        {lt('regalo.result.disclaimer')}{' '}
        <a href={getScSiteUrl('/test-de-crianza')} className="sc-link whitespace-nowrap">
          {lt('regalo.result.retake')}
        </a>
      </p>
    </section>
  )
}

// ---------------------------------------------------------------------------
// The free ebook card (states verified / unverified / pending)
// ---------------------------------------------------------------------------

type ResendState = { state: 'idle' | 'sending' | 'sent' | 'error'; message?: string }

function GiftCard({
  view,
  lt,
  headingRef,
  withResult,
  readHref,
  email,
  mark,
  loginHref,
  resend,
  onResend,
  checking,
  stillUnverified,
  onVerified,
  justVerified,
  joined,
}: {
  view: Exclude<RegaloView, 'gate'>
  lt: LearningTranslate
  /** Lets the page move focus here once «Ya lo verifiqué» confirms the email. */
  headingRef: React.Ref<HTMLHeadingElement>
  /** The page shows a test result above (else its own heading names the guide). */
  withResult: boolean
  readHref: string | null
  /** The session's email (unverified state). */
  email: string | null
  mark: SignupMark | null
  loginHref: string
  resend: ResendState
  onResend: (_email: string) => void
  checking: boolean
  stillUnverified: boolean
  onVerified: () => void
  /** The email was confirmed while the page was open: say the guide is ready. */
  justVerified: boolean
  /** The reader is on the newsletter list (subscribe/me answered, or remembered). */
  joined: boolean
}) {
  let title: string
  let text: string
  let body: React.ReactNode

  if (view === 'verified') {
    // Without a result the page heading is already «Tu guía gratis te
    // espera», so the card does not repeat «Tu guía gratis…».
    title = withResult ? lt('regalo.gift.ready_title') : lt('regalo.gift.ready_title_free')
    text = readHref ? lt('regalo.gift.ready_text') : lt('regalo.gift.ready_text_generic')
    body = readHref ? (
      <Link href={readHref} prefetch={false} className="sc-btn sc-btn-primary w-full sm:w-auto">
        <BookOpen size={18} strokeWidth={1.75} aria-hidden="true" />
        {lt('regalo.gift.read')}
      </Link>
    ) : null
  } else if (view === 'pending' && mark?.verified) {
    // The account came out verified (verification switched off): it only needs a login.
    title = lt('regalo.gift.created_title')
    text = lt('regalo.gift.created_text')
    body = (
      <Link href={loginHref} prefetch={false} className="sc-btn sc-btn-primary w-full sm:w-auto">
        <LogIn size={18} strokeWidth={1.75} aria-hidden="true" />
        {lt('regalo.gift.login')}
      </Link>
    )
  } else {
    const to = view === 'pending' ? mark?.email ?? null : email
    if (view === 'pending') {
      title = lt('regalo.gift.pending_title')
      text = lt('regalo.gift.pending_text', { email: to })
    } else {
      title = lt('regalo.gift.verify_title')
      text = to ? lt('regalo.gift.verify_text', { email: to }) : lt('regalo.gift.verify_text_no_email')
    }
    body = (
      <>
        <button
          type="button"
          onClick={() => to && onResend(to)}
          disabled={!to || resend.state === 'sending'}
          className="sc-btn sc-btn-primary w-full disabled:opacity-70 sm:w-auto"
        >
          <RefreshCw size={18} strokeWidth={1.75} className={resend.state === 'sending' ? 'animate-spin' : ''} aria-hidden="true" />
          {resend.state === 'sending' ? lt('free_gate.resending') : lt('free_gate.resend')}
        </button>
        {view === 'unverified' ? (
          <button type="button" onClick={onVerified} disabled={checking} className="sc-btn sc-btn-outline w-full disabled:opacity-70 sm:w-auto">
            {checking ? lt('free_gate.checking') : lt('free_gate.verified')}
          </button>
        ) : (
          <p className="text-[0.9375rem] text-violeta-600">
            {lt('regalo.gift.pending_activated')}{' '}
            <Link href={loginHref} prefetch={false} className="sc-link">
              {lt('regalo.gift.login')}
            </Link>
          </p>
        )}
      </>
    )
  }

  return (
    <section id={GIFT_ID} aria-labelledby="regalo-gift-title" className="sc-card mt-10 scroll-mt-24 p-5 sm:p-7">
      <div className="flex items-start gap-3.5">
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-lavanda-100 text-lavanda-600">
          {view === 'verified' ? <Gift size={21} strokeWidth={1.75} aria-hidden="true" /> : <Mail size={21} strokeWidth={1.75} aria-hidden="true" />}
        </span>
        <div className="min-w-0">
          <h2
            id="regalo-gift-title"
            ref={headingRef}
            tabIndex={-1}
            className="text-xl font-semibold leading-snug text-violeta focus:outline-none sm:text-2xl"
          >
            {title}
          </h2>
          <p className="mt-2 text-[0.9375rem] leading-relaxed text-violeta-600 break-words [overflow-wrap:anywhere]">{text}</p>
        </div>
      </div>
      {body && <div className="mt-5 flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">{body}</div>}
      <div aria-live="polite">
        {view === 'verified' && justVerified && <p className="sr-only">{lt('regalo.gift.ready_title')}</p>}
        {view === 'verified' && joined && (
          <p className="mt-4 text-sm leading-relaxed text-violeta-600">{lt('regalo.gift.subscribed')}</p>
        )}
        {/* The resend notices belong to the "activate" card, not to the ready one. */}
        {view !== 'verified' && resend.state === 'sent' && (
          <p className="mt-3 text-sm font-medium text-lavanda-700">{lt('free_gate.resent')}</p>
        )}
        {view !== 'verified' && resend.state === 'error' && (
          <p className="mt-3 text-sm font-medium text-[#B42318]">{resend.message || lt('free_gate.resend_error')}</p>
        )}
        {view === 'unverified' && stillUnverified && !checking && (
          <p className="mt-3 text-sm text-violeta-600">{lt('free_gate.still_unverified')}</p>
        )}
      </div>
    </section>
  )
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function RegaloPage({ orgslug, orgId, params, offer, storeEnabled }: RegaloPageProps) {
  const { lt, lng } = useLearningT()
  const session = useLHSession() as any
  const user = session?.data?.user
  const token: string | null = session?.data?.tokens?.access_token ?? null
  const userKey: string | null = user?.user_uuid ?? (user?.id != null ? String(user.id) : null)
  const path = useMemo(() => regaloPath(params), [params])
  // Without a store there is nothing to buy: no price and no purchase links.
  const oferta = storeEnabled ? params.oferta : null

  // The sign-up mark lives in sessionStorage: a string snapshot (compared by
  // value), "null" during the server render and hydration (as useCart).
  const markSnapshot = useSyncExternalStore(
    noopSubscribe,
    () => JSON.stringify(readSignupMark(path)),
    () => 'null'
  )
  const markRead = useSyncExternalStore(noopSubscribe, () => true, () => false)
  const mark = useMemo<SignupMark | null>(() => JSON.parse(markSnapshot), [markSnapshot])

  const view = regaloView({ status: session?.status, user, hasMark: !!mark })

  // Verified: join the newsletter once with this origin. The API takes the
  // email and the name from the session. Once she is on the list (now, or
  // remembered from an earlier visit) the card says so.
  const subKey = subscribedKey(orgId, userKey, params.origen)
  const joinedBefore = useSyncExternalStore(noopSubscribe, () => wasSubscribed(subKey), () => false)
  const [joinedKey, setJoinedKey] = useState<string | null>(null)
  const joined = joinedBefore || (subKey !== null && joinedKey === subKey)
  const subscribing = useRef(false)
  useEffect(() => {
    if (view !== 'verified' || !token || subscribing.current) return
    if (!subKey || wasSubscribed(subKey)) return
    subscribing.current = true
    subscribeMeToNewsletter(orgId, { source: params.origen, page: REGALO_PATH }, token)
      .then((res) => {
        if (!res.success) return
        rememberSubscribed(subKey)
        setJoinedKey(subKey)
      })
      // Errors and rate limits stay silent: the next visit tries again.
      .catch(() => {})
  }, [view, token, orgId, subKey, params.origen])

  // «Ya lo verifiqué» (or the session's periodic refresh) found the email
  // verified: the card swaps «Ya lo verifiqué», which had the focus, for
  // «Leer mi guía». Focus moves to the card heading, unless the reader is
  // already elsewhere on the page, and the live region says the guide is ready.
  const giftHeadingRef = useRef<HTMLHeadingElement>(null)
  const [lastView, setLastView] = useState(view)
  const [justVerified, setJustVerified] = useState(false)
  if (view !== 'loading' && view !== lastView) {
    setLastView(view)
    if (lastView === 'unverified' && view === 'verified') setJustVerified(true)
  }
  useEffect(() => {
    if (!justVerified) return
    const active = document.activeElement
    // preventScroll: when the periodic session refresh is what flips the view,
    // the page must not jump while she is reading the result above the card.
    if (!active || active === document.body) giftHeadingRef.current?.focus({ preventScroll: true })
  }, [justVerified])

  // Not verified yet: the verification link carries ?redirect back here; in
  // the same browser /verify-email can also use the remembered path.
  useEffect(() => {
    if (view === 'unverified' || view === 'pending') rememberReturnPath(path)
  }, [view, path])

  const [resend, setResend] = useState<ResendState>({ state: 'idle' })
  const onResend = async (email: string) => {
    setResend({ state: 'sending' })
    const res = await resendVerificationEmail(email, orgId, path)
    if (res.success) setResend({ state: 'sent' })
    // A rate limit (429) gets its own copy: wait a few minutes.
    else setResend({ state: 'error', message: res.status === 429 ? lt('free_gate.resend_rate_limited') : undefined })
  }

  // «Ya lo verifiqué»: a fresh session. Verified now, the page switches to the
  // verified state by itself; otherwise the notice below the buttons shows.
  const [checking, setChecking] = useState(false)
  const [stillUnverified, setStillUnverified] = useState(false)
  const onVerified = async () => {
    setChecking(true)
    setStillUnverified(false)
    try {
      await session?.update?.(true)
    } catch {
      /* the session stays as it was: the notice asks to try again */
    } finally {
      setChecking(false)
      setStillUnverified(true)
    }
  }

  // «Lo quiero» goes to the cart only while Pago Móvil is on (like the store).
  const wantsBuy = !!oferta && params.resultado === 'limites' && showsResult(view)
  const { providers } = useCheckoutProviders(wantsBuy ? orgId : undefined)
  const cartEnabled = providers.some((p) => String(p.provider ?? '').toLowerCase() === 'manual')

  const price = useMemo(() => {
    if (!oferta || !offer || !Number.isFinite(offer.amount) || !offer.currency) return null
    try {
      return formatCurrency(offer.amount, offer.currency, lng)
    } catch {
      return null
    }
  }, [oferta, offer, lng])

  const orgHref = (p: string | null) => (p ? getUriWithOrg(orgslug, p) : null)
  const signupHref = getUriWithOrg(orgslug, regaloAuthHref('signup', path))
  const loginHref = getUriWithOrg(orgslug, regaloAuthHref('login', path))
  const readHref = view === 'verified' ? orgHref(guiaHref(params.guia)) : null
  const offerLink = orgHref(offerHref(oferta))
  const buyLink = orgHref(buyHref(oferta, cartEnabled, offer?.offer_type))

  // Until the mark is read, an anonymous visitor could still be "pending":
  // keep the space instead of flashing the gate.
  if (view === 'loading' || (view === 'gate' && !markRead)) {
    return <div className="min-h-[60vh]" aria-busy="true" />
  }

  if (view === 'gate') {
    const withResult = params.resultado !== null
    return (
      <div className="w-full">
        <GeneralWrapperStyled>
          <div className="mx-auto max-w-xl py-4 sm:py-10">
            <section className="sc-card px-5 py-8 text-center sm:px-10 sm:py-10" aria-labelledby="regalo-gate-title">
              <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-lavanda-100 text-lavanda-600">
                <Gift size={26} strokeWidth={1.75} aria-hidden="true" />
              </span>
              <h1 id="regalo-gate-title" className="mt-5 text-[1.75rem] leading-tight font-semibold text-violeta sm:text-[2rem]">
                {withResult ? lt('regalo.gate.result_title') : lt('regalo.gate.free_title')}
              </h1>
              <p className="mx-auto mt-3 max-w-[42ch] text-[1.0625rem] leading-relaxed text-violeta-600">
                {withResult ? lt('regalo.gate.result_text') : lt('regalo.gate.free_text')}
              </p>
              <div className="mt-7 flex flex-col gap-3 sm:flex-row sm:justify-center">
                <Link href={signupHref} prefetch={false} className="sc-btn sc-btn-primary">
                  <UserPlus size={18} strokeWidth={1.75} aria-hidden="true" />
                  {lt('regalo.gate.signup')}
                </Link>
                <Link href={loginHref} prefetch={false} className="sc-btn sc-btn-outline">
                  <LogIn size={18} strokeWidth={1.75} aria-hidden="true" />
                  {lt('regalo.gate.login')}
                </Link>
              </div>
            </section>
          </div>
        </GeneralWrapperStyled>
      </div>
    )
  }

  return (
    <div className="w-full">
      <GeneralWrapperStyled>
        <div className="mx-auto max-w-2xl pt-2 pb-8 tracking-normal sm:pt-6">
          {params.resultado ? (
            <ResultSection
              resultado={params.resultado}
              lt={lt}
              readHref={readHref}
              buyLink={buyLink}
              offerLink={offerLink}
              price={price}
            />
          ) : (
            <header>
              <p className="sc-eyebrow">{lt('regalo.eyebrow')}</p>
              <h1 className="mt-3 text-[1.875rem] leading-[1.15] font-semibold text-violeta sm:text-[2.5rem]">
                {lt('regalo.free_title')}
              </h1>
            </header>
          )}

          <GiftCard
            view={view}
            lt={lt}
            headingRef={giftHeadingRef}
            withResult={params.resultado !== null}
            readHref={readHref}
            email={typeof user?.email === 'string' ? user.email : null}
            mark={mark}
            loginHref={loginHref}
            resend={resend}
            onResend={onResend}
            checking={checking}
            stillUnverified={stillUnverified}
            onVerified={onVerified}
            justVerified={justVerified}
            joined={joined}
          />

          {!params.resultado && offerLink && (
            <section aria-labelledby="regalo-sale-title" className="mt-6 rounded-[20px] border border-lavanda-300/70 bg-lavanda-100 p-5 sm:p-7">
              <h2 id="regalo-sale-title" className="text-xl font-semibold leading-snug text-violeta sm:text-2xl">
                {lt('regalo.sale.title')}
              </h2>
              <p className="mt-2 text-[1.0625rem] leading-relaxed text-violeta-600">
                <Accented
                  text={price ? lt('regalo.sale.text_price', { price }) : lt('regalo.sale.text')}
                  accentClassName="font-heading italic font-semibold text-lavanda-700"
                />
              </p>
              <Link href={offerLink} prefetch={false} className="sc-btn sc-btn-outline mt-5 w-full sm:w-auto">
                {lt('regalo.sale.cta')}
                <ArrowRight size={16} strokeWidth={1.75} aria-hidden="true" />
              </Link>
            </section>
          )}
        </div>
      </GeneralWrapperStyled>
    </div>
  )
}
