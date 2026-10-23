'use client';
import React, { useState } from 'react';
import { useOrg } from '@components/Contexts/OrgContext';
import { useLHSession } from '@components/Contexts/LHSessionContext';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { queryKeys } from '@/lib/query/keys';
import toast from 'react-hot-toast';
import { BookOpen, BookMarked, Mic, Puzzle, X, Plus, Loader2 } from 'lucide-react';
import { getOrgCourses } from '@services/courses/courses';
import { getOfferResources, addOfferResource, removeOfferResource } from '@services/payments/groups';
import { useScT } from '@components/Payments/useScT';
import { describePaymentError, productTypeOfCourse } from '@components/Payments/commerce';

interface OfferResourcesPanelProps {
  offerId: number;
  offerName: string;
}

function resourceIcon(uuid: string, isEbook: boolean) {
  if (uuid.startsWith('course_')) {
    return isEbook ? <BookMarked size={14} className="text-[#AC4691]" /> : <BookOpen size={14} className="text-[#6559CA]" />;
  }
  if (uuid.startsWith('podcast_')) return <Mic size={14} className="text-pink-400" />;
  return <Puzzle size={14} className="text-gray-400" />;
}

const courseResourceUuid = (c: any) => `course_${c.course_uuid?.replace('course_', '')}`;

function OfferResourcesPanel({ offerId, offerName }: OfferResourcesPanelProps) {
  const org = useOrg() as any;
  const session = useLHSession() as any;
  const token = session?.data?.tokens?.access_token;
  const queryClient = useQueryClient();
  const { sc } = useScT();
  const [showPicker, setShowPicker] = useState(false);
  const [isLinking, setIsLinking] = useState(false);

  const resourceQueryKey = ['offers', offerId, 'resources', org?.id];

  const { data: resources, error } = useQuery({
    queryKey: resourceQueryKey,
    queryFn: () => getOfferResources(org.id, offerId, token),
    enabled: !!(org?.id && token),
    staleTime: 60_000,
  });

  // Sanar y Criar: always loaded, so linked resources show names, not uuids.
  const { data: coursesData } = useQuery({
    queryKey: queryKeys.courses.list(org?.slug ?? ''),
    queryFn: () => getOrgCourses(org.slug, null, token, true),
    enabled: !!(org?.slug && token),
    staleTime: 60_000,
  });

  if (error) return <div className="text-sm text-red-500">{sc('resources_panel.load_error')}</div>;
  if (!resources) return <div className="text-sm text-gray-400">{sc('resources_panel.loading')}</div>;

  const list: string[] = Array.isArray(resources?.data) ? resources.data : Array.isArray(resources) ? resources : [];
  const courses: any[] = Array.isArray(coursesData) ? coursesData : [];
  const byUuid = new Map(courses.map((c: any) => [courseResourceUuid(c), c]));
  const linkedUuids = new Set(list);
  const availableCourses = courses.filter((c: any) => !linkedUuids.has(courseResourceUuid(c)));

  // Sanar y Criar: catalog surfaces (store, course pages) cache offers too.
  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: resourceQueryKey });
    queryClient.invalidateQueries({ queryKey: ['offers', 'by-resource'] });
    queryClient.invalidateQueries({ queryKey: ['payments', org?.id, 'access'] });
  };

  // Sanar y Criar: getResponseMetadata never throws, so check res.success
  // instead of reporting success for a failed call.
  const handleRemove = async (resourceUuid: string) => {
    try {
      const res = await removeOfferResource(org.id, offerId, resourceUuid, token);
      if (!res.success) {
        toast.error(describePaymentError(res.data, sc, 'resources_panel.remove_error'));
        return;
      }
      invalidate();
      toast.success(sc('resources_panel.removed'));
    } catch {
      toast.error(sc('resources_panel.remove_error'));
    }
  };

  const handleLinkCourse = async (course: any) => {
    const courseUuid = courseResourceUuid(course);
    setIsLinking(true);
    try {
      const res = await addOfferResource(org.id, offerId, courseUuid, token);
      if (!res.success) {
        toast.error(describePaymentError(res.data, sc, 'resources_panel.link_error'));
        return;
      }
      invalidate();
      toast.success(sc('resources_panel.linked'));
      setShowPicker(false);
    } catch {
      toast.error(sc('resources_panel.link_error'));
    } finally {
      setIsLinking(false);
    }
  };

  return (
    <div className="space-y-2">
      <p className="text-xs text-gray-500">
        {sc('resources_panel.intro', { name: offerName })}
      </p>

      {list.length === 0 ? (
        <p className="text-sm text-gray-400 italic">{sc('resources_panel.empty')}</p>
      ) : (
        <ul className="space-y-1">
          {list.map((uuid: string) => {
            const course = byUuid.get(uuid);
            const isEbook = productTypeOfCourse(course) === 'ebook';
            return (
              <li key={uuid} className="flex items-center justify-between bg-[#EEEDFF]/60 rounded px-3 py-1.5 text-sm">
                <div className="flex items-center space-x-2 min-w-0">
                  {resourceIcon(uuid, isEbook)}
                  <span className="text-xs font-medium text-gray-500">
                    {isEbook ? sc('product.ebook') : sc('product.course')}
                  </span>
                  {course ? (
                    <span className="text-xs truncate max-w-[220px]">{course.name}</span>
                  ) : (
                    <span className="font-mono text-xs truncate max-w-[200px]">{uuid}</span>
                  )}
                </div>
                <button
                  onClick={() => handleRemove(uuid)}
                  className="text-red-400 hover:text-red-600 ms-2"
                  title={sc('common.remove')}
                >
                  <X size={14} />
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {!showPicker ? (
        <button
          className="flex items-center gap-1.5 text-xs text-[#6559CA] hover:text-[#4F43A4] mt-1"
          onClick={() => setShowPicker(true)}
        >
          <Plus size={12} /> {sc('resources_panel.link_course')}
        </button>
      ) : (
        <div className="border rounded-md p-2 space-y-1 bg-gray-50">
          <div className="flex items-center justify-between mb-1">
            <span className="text-xs font-medium text-gray-700">{sc('resources_panel.select_course')}</span>
            <button onClick={() => setShowPicker(false)} className="text-gray-400 hover:text-gray-600">
              <X size={12} />
            </button>
          </div>
          {!coursesData ? (
            <div className="flex items-center gap-1 text-xs text-gray-500 py-1">
              <Loader2 size={12} className="animate-spin" /> {sc('resources_panel.loading_courses')}
            </div>
          ) : availableCourses.length === 0 ? (
            <p className="text-xs text-gray-400 italic py-1">
              {courses.length === 0 ? sc('resources_panel.no_courses') : sc('resources_panel.all_linked')}
            </p>
          ) : (
            <ul className="max-h-40 overflow-y-auto space-y-0.5">
              {availableCourses.map((course: any) => (
                <li key={course.course_uuid}>
                  <button
                    disabled={isLinking}
                    onClick={() => handleLinkCourse(course)}
                    className="w-full text-start px-2 py-1.5 rounded text-xs hover:bg-white flex items-center gap-2 disabled:opacity-50"
                  >
                    {productTypeOfCourse(course) === 'ebook'
                      ? <BookMarked size={12} className="text-[#AC4691] shrink-0" />
                      : <BookOpen size={12} className="text-[#6559CA] shrink-0" />}
                    <span className="truncate">{course.name}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

export default OfferResourcesPanel;
