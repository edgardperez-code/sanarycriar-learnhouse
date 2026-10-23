'use client';
// Sanar y Criar: confirmation before archiving an offer. A course (or ebook)
// is for sale only while some non-archived offer covers it (directly or via
// its payment group), so archiving the only offer that covers one makes it
// free for everyone. The dialog re-reads the offers when it opens (the cached
// list can be stale after resource edits) and says so before going ahead.
import React from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, BookMarked, BookOpen, Loader2 } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@components/ui/dialog';
import { useOrg } from '@components/Contexts/OrgContext';
import { useLHSession } from '@components/Contexts/LHSessionContext';
import { queryKeys } from '@/lib/query/keys';
import { getOffers } from '@services/payments/offers';
import { getOrgCourses } from '@services/courses/courses';
import { productTypeOfCourse } from '@components/Payments/commerce';
import { useScT } from '@components/Payments/useScT';
import { useFixesT } from '@components/ScFixes/useFixesT';

type OfferLike = { id: number | string; name?: string; archived?: boolean; resource_uuids?: string[] };

const courseKey = (uuid?: string | null) => `course_${String(uuid || '').replace(/^course_/, '')}`;

/**
 * Resource uuids of `offer` that no other non-archived offer in `offers`
 * covers: archiving `offer` would make them free. `resource_uuids` of the
 * admin listing already include courses reached through a payment group.
 */
export function resourcesOnlyCoveredBy(offer: OfferLike, offers: OfferLike[]): string[] {
  const coveredElsewhere = new Set<string>();
  for (const other of offers) {
    if (String(other.id) === String(offer.id) || other.archived) continue;
    for (const uuid of other.resource_uuids ?? []) coveredElsewhere.add(courseKey(uuid));
  }
  const own = Array.from(new Set((offer.resource_uuids ?? []).map(courseKey)));
  return own.filter((uuid) => !coveredElsewhere.has(uuid));
}

type Impact =
  | { state: 'checking' }
  | { state: 'error' }
  | { state: 'ready'; freed: { uuid: string; name: string | null; isEbook: boolean }[] };

export default function ArchiveOfferDialog({
  offer,
  open,
  requestKey,
  onClose,
  onArchive,
}: {
  offer: OfferLike | null;
  open: boolean;
  /** Changes on every opening, so each one checks afresh. */
  requestKey: number | null;
  onClose: () => void;
  /** Resolves true when the offer was archived (the dialog then closes). */
  onArchive: (_offerId: number | string) => Promise<boolean>;
}) {
  const org = useOrg() as any;
  const session = useLHSession() as any;
  const token = session?.data?.tokens?.access_token;
  const queryClient = useQueryClient();
  const { sc } = useScT();
  const { fx } = useFixesT();
  const [result, setResult] = React.useState<{ key: number; impact: Impact } | null>(null);
  const [pending, setPending] = React.useState(false);
  const cancelRef = React.useRef<HTMLButtonElement>(null);
  const offerId = offer?.id;
  // Until the check for *this* opening lands, it is still checking.
  const impact: Impact =
    result && requestKey != null && result.key === requestKey ? result.impact : { state: 'checking' };

  React.useEffect(() => {
    if (!open || requestKey == null || offerId == null || !org?.id) return;
    let cancelled = false;
    const settle = (value: Impact) => {
      if (!cancelled) setResult({ key: requestKey, impact: value });
    };
    (async () => {
      try {
        const fresh: any = await queryClient.fetchQuery({
          queryKey: queryKeys.payments.offers(org.id),
          queryFn: () => getOffers(org.id, token),
          staleTime: 0,
        });
        if (!fresh?.success || !Array.isArray(fresh.data)) throw new Error('offers unavailable');
        const list: OfferLike[] = fresh.data;
        const current = list.find((o) => String(o.id) === String(offerId)) ?? offer!;
        const freedUuids = resourcesOnlyCoveredBy(current, list);

        // Names are a nicety: fall back to the uuid when the catalog fails.
        let courses: any[] = [];
        if (freedUuids.length && org?.slug) {
          try {
            const data = await queryClient.fetchQuery({
              queryKey: queryKeys.courses.list(org.slug),
              queryFn: () => getOrgCourses(org.slug, null, token, true),
              staleTime: 60_000,
            });
            // Some screens cache this key as the raw array, others as { data }.
            courses = Array.isArray(data) ? data : Array.isArray((data as any)?.data) ? (data as any).data : [];
          } catch {
            courses = [];
          }
        }
        const byUuid = new Map(courses.map((c: any) => [courseKey(c.course_uuid), c]));
        const freed = freedUuids.map((uuid) => {
          const course = byUuid.get(uuid);
          return { uuid, name: course?.name ?? null, isEbook: productTypeOfCourse(course) === 'ebook' };
        });
        settle({ state: 'ready', freed });
      } catch {
        settle({ state: 'error' });
      }
    })();
    return () => {
      cancelled = true;
    };
    // Re-check on every opening (requestKey), not on each parent render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, requestKey, org?.id]);

  const confirm = async () => {
    if (!offer || pending) return;
    setPending(true);
    try {
      if (await onArchive(offer.id)) onClose();
    } finally {
      setPending(false);
    }
  };

  const freed = impact.state === 'ready' ? impact.freed : [];
  const makesFree = freed.length > 0;
  const confirmLabel = makesFree
    ? fx('offers_archive.confirm_free', { count: freed.length })
    : sc('offers.archive');

  return (
    <Dialog
      open={open && !!offer}
      onOpenChange={(next) => {
        if (!next && !pending) onClose();
      }}
    >
      <DialogContent
        className="w-[calc(100vw-32px)] max-w-lg rounded-[20px] p-6"
        // Start on the safe choice, not on the destructive button.
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          cancelRef.current?.focus();
        }}
      >
        <DialogHeader className="space-y-2 pe-8 text-start">
          <DialogTitle className="text-xl font-semibold leading-snug text-[#190933]">
            {sc('offers.archive_title', { name: offer?.name ?? '' })}
          </DialogTitle>
          <DialogDescription className="text-sm leading-relaxed text-[#584F72]">
            {sc('offers.archive_confirm')}
          </DialogDescription>
        </DialogHeader>

        <div className="mt-4" aria-live="polite">
          {impact.state === 'checking' && (
            <p className="flex items-center gap-2 text-sm text-[#6D6485]">
              <Loader2 size={14} className="animate-spin" />
              {fx('offers_archive.checking')}
            </p>
          )}

          {impact.state === 'error' && (
            <div className="flex gap-3 rounded-xl border border-[#F0B4DF] bg-[#F9DDF0]/40 p-3 text-sm text-[#41375B]">
              <AlertTriangle size={18} className="mt-0.5 shrink-0 text-[#AC4691]" />
              <p>{fx('offers_archive.check_failed')}</p>
            </div>
          )}

          {makesFree && (
            <div role="alert" className="rounded-xl border border-[#F0B4DF] bg-[#F9DDF0]/40 p-4 text-sm text-[#41375B]">
              <div className="flex items-center gap-2">
                <AlertTriangle size={18} className="shrink-0 text-[#AC4691]" />
                <h4 className="font-semibold text-[#190933]">{fx('offers_archive.free_title')}</h4>
              </div>
              <p className="mt-2">{fx('offers_archive.free_description', { count: freed.length })}</p>
              <ul className="mt-2 space-y-1.5">
                {freed.map((item) => (
                  <li key={item.uuid} className="flex items-center gap-2">
                    {item.isEbook ? (
                      <BookMarked size={14} className="shrink-0 text-[#AC4691]" />
                    ) : (
                      <BookOpen size={14} className="shrink-0 text-[#6559CA]" />
                    )}
                    <span className="font-medium text-[#190933] break-words" dir="auto">
                      {item.name ?? fx('offers_archive.unknown_resource', { id: item.uuid.replace(/^course_/, '') })}
                    </span>
                    <span className="shrink-0 text-xs text-[#6D6485]">
                      · {item.isEbook ? fx('offers_archive.type_ebook') : fx('offers_archive.type_course')}
                    </span>
                  </li>
                ))}
              </ul>
              <p className="mt-3 text-[#584F72]">{fx('offers_archive.free_hint', { count: freed.length })}</p>
            </div>
          )}
        </div>

        <DialogFooter className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end sm:space-x-0">
          <button
            type="button"
            onClick={confirm}
            disabled={pending || impact.state === 'checking'}
            aria-busy={pending}
            className={`inline-flex items-center justify-center gap-2 rounded-full px-5 py-2.5 text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-300 disabled:opacity-60 cursor-pointer disabled:cursor-not-allowed ${
              makesFree
                ? 'border border-red-200 bg-white text-red-600 hover:bg-red-50'
                : 'bg-red-500 text-white hover:bg-red-600'
            }`}
          >
            {pending && <Loader2 size={14} className="animate-spin" />}
            {pending ? fx('offers_archive.archiving') : confirmLabel}
          </button>
          <button
            type="button"
            ref={cancelRef}
            onClick={onClose}
            disabled={pending}
            className={`inline-flex items-center justify-center rounded-full px-5 py-2.5 text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#7D75E2] focus-visible:ring-offset-2 disabled:opacity-60 cursor-pointer ${
              makesFree
                ? 'bg-[#190933] text-white hover:bg-[#41375B]'
                : 'border border-[#EAE8F2] bg-white text-[#190933] hover:bg-[#EEEDFF]'
            }`}
          >
            {sc('common.cancel')}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
