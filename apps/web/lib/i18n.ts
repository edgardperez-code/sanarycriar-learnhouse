'use client'

import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import LanguageDetector from 'i18next-browser-languagedetector';
// Sanar y Criar: Spanish is the platform language, so it is the bundled locale
// (server render and first client render both use it). English is lazy-loaded.
import es from '../locales/es.json';
import { loadDateLocale } from './format';

const LOCALE_LOADERS: Record<string, () => Promise<{ default: any }>> = {
  fr: () => import('../locales/fr.json'),
  de: () => import('../locales/de.json'),
  es: () => import('../locales/es.json'),
  ar: () => import('../locales/ar.json'),
  ja: () => import('../locales/ja.json'),
  pt: () => import('../locales/pt.json'),
  ru: () => import('../locales/ru.json'),
  zh: () => import('../locales/zh.json'),
  hi: () => import('../locales/hi.json'),
  ko: () => import('../locales/ko.json'),
  it: () => import('../locales/it.json'),
  tr: () => import('../locales/tr.json'),
  vi: () => import('../locales/vi.json'),
  id: () => import('../locales/id.json'),
  pl: () => import('../locales/pl.json'),
  uk: () => import('../locales/uk.json'),
  nl: () => import('../locales/nl.json'),
  th: () => import('../locales/th.json'),
  bn: () => import('../locales/bn.json'),
  fa: () => import('../locales/fa.json'),
  sk: () => import('../locales/sk.json'),
};

// Sanar y Criar: English is not bundled any more; it loads on demand (when
// picked, and in the background as the last fallback for any key es lacks).
const loadEnglish = () => import('../locales/en.json');

/** Sanar y Criar: the language everyone gets unless they explicitly pick another. */
export const DEFAULT_LANGUAGE = 'es';

/**
 * Sanar y Criar: set by the language pickers. Only a language the user chose
 * is restored on the next visit; a stored value without this flag (e.g. one an
 * older build cached from the browser language) is ignored.
 */
export const USER_PICKED_KEY = 'i18nextLng_userPicked';

const resources = {
  es: { common: es },
};

// Sanar y Criar: `silent` adds the bundle without the store's 'added' event,
// so a background load does not re-render every translated component.
async function loadLocale(lng: string, { silent = false }: { silent?: boolean } = {}) {
  const code = lng.split('-')[0]
  if (i18n.hasResourceBundle(code, 'common')) return;
  const loader = code === 'en' ? loadEnglish : LOCALE_LOADERS[code];
  if (!loader) return;

  try {
    const mod = await loader();
    i18n.addResourceBundle(code, 'common', mod.default, true, true, { silent });
  } catch (e) {
    console.warn(`Failed to load locale: ${lng}`, e);
  }
}

// Sanar y Criar: replaces browser-language detection. Returns the stored
// language only when the user picked it explicitly.
const userPickDetector = {
  name: 'scUserPick',
  lookup() {
    try {
      if (typeof window === 'undefined') return undefined;
      if (!window.localStorage.getItem(USER_PICKED_KEY)) return undefined;
      return window.localStorage.getItem('i18nextLng') || undefined;
    } catch {
      return undefined; // private mode / sandboxed iframe
    }
  },
};

const detector = new LanguageDetector();
detector.addDetector(userPickDetector);

i18n
  .use(detector)
  .use(initReactI18next)
  .init({
    resources,
    // Sanar y Criar: Spanish first. With no explicit pick, detection finds
    // nothing and i18next settles on the first fallback, so the server and the
    // first client render agree on 'es'.
    fallbackLng: [DEFAULT_LANGUAGE, 'en'],
    ns: ['common'],
    defaultNS: 'common',
    interpolation: {
      escapeValue: false, // react already safes from xss
    },
    detection: {
      // Sanar y Criar: no 'navigator', 'cookie', 'path' or 'subdomain'.
      order: ['scUserPick', 'querystring'],
      caches: ['localStorage', 'cookie'],
      lookupLocalStorage: 'i18nextLng',
      lookupCookie: 'i18next',
    },
    react: {
      useSuspense: false,
      // Sanar y Criar: re-render when a lazily loaded bundle lands, so an
      // explicitly picked language shows up without another trigger.
      bindI18nStore: 'added',
    }
  });

// Load the detected language if it isn't bundled, and export the promise
// so I18nProvider can wait for resources before rendering.
// The date locale rides along: dayjs keeps its own registry, and without this
// every "2 hours ago" renders in English no matter the language.
export const initialLocaleReady = Promise.all([
  loadLocale(i18n.language.split('-')[0]),
  loadDateLocale(i18n.language),
]).then(() => undefined);

// Sanar y Criar: English is the last fallback; fetch it off the critical path.
// Silent: es.json has every key, so nothing on screen changes when it lands.
if (typeof window !== 'undefined') {
  void initialLocaleReady.then(() => loadLocale('en', { silent: true }));
}

async function switchLanguage(lng: string) {
  await Promise.all([loadLocale(lng), loadDateLocale(lng)])
  return i18n.changeLanguage(lng)
}

/**
 * Switch language safely: preloads the bundle before switching
 * so the UI never flashes a fallback language.
 *
 * Sanar y Criar: callers are the language pickers, so this records the choice
 * as the user's own (see USER_PICKED_KEY).
 */
export async function changeLanguage(lng: string) {
  try {
    localStorage.setItem(USER_PICKED_KEY, '1')
  } catch { /* ignore */ }
  return switchLanguage(lng)
}

/**
 * Sanar y Criar: switch to an org's default language without marking it as
 * the user's own pick (used by OrgLanguageSync).
 */
export async function applyOrgLanguage(lng: string) {
  return switchLanguage(lng)
}

export default i18n;
