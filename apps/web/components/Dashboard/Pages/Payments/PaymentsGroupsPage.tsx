'use client';
import React, { useState } from 'react';
import { useOrg } from '@components/Contexts/OrgContext';
import { useLHSession } from '@components/Contexts/LHSessionContext';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { queryKeys } from '@/lib/query/keys';
import {
  getPaymentsGroups,
  createPaymentsGroup,
  updatePaymentsGroup,
  deletePaymentsGroup,
  getGroupResources,
  addGroupResource,
  removeGroupResource,
  getGroupSyncs,
  addGroupSync,
  removeGroupSync,
} from '@services/payments/groups';
import {
  Plus, Pencil, Trash2, X, BookOpen, Users, RefreshCcw, Layers,
  ChevronDown,
} from 'lucide-react';
import { Button } from '@components/ui/button';
import { Input } from '@components/ui/input';
import { Textarea } from '@components/ui/textarea';
import { Label } from '@components/ui/label';
import Modal from '@components/Objects/StyledElements/Modal/Modal';
import ConfirmationModal from '@components/Objects/StyledElements/ConfirmationModal/ConfirmationModal';
import toast from 'react-hot-toast';
import { getOrgCourses } from '@services/courses/courses';
import { usePaymentsEnabled } from '@hooks/usePaymentsEnabled';
import UnconfiguredPaymentsDisclaimer from '@components/Pages/Payments/UnconfiguredPaymentsDisclaimer';
import { useScT } from '@components/Payments/useScT';
import { describePaymentError } from '@components/Payments/commerce';

// ---------------------------------------------------------------------------
// Group Resources Panel
// ---------------------------------------------------------------------------

function GroupResourcePanel({ group, orgId, token }: { group: any; orgId: number; token: string }) {
  const org = useOrg() as any;
  const queryClient = useQueryClient();
  const { sc } = useScT();
  const [pickerOpen, setPickerOpen] = useState(false);

  const resourceQueryKey = ['payments', orgId, 'groups', group.id, 'resources'];

  const { data: resources } = useQuery({
    queryKey: resourceQueryKey,
    queryFn: () => getGroupResources(orgId, group.id, token),
    enabled: !!(orgId && token),
    staleTime: 60_000,
  });

  const { data: coursesData } = useQuery({
    queryKey: queryKeys.courses.list(org?.slug ?? ''),
    queryFn: () => getOrgCourses(org.slug, null, token, true),
    enabled: !!(org?.slug && token),
    staleTime: 60_000,
  });

  const rawList: string[] = Array.isArray(resources?.data) ? resources.data : Array.isArray(resources) ? resources : [];
  const courses: any[] = coursesData ?? [];

  // Build a name map from courses
  const nameMap: Record<string, string> = {};
  courses.forEach((c: any) => {
    const uuid = `course_${c.course_uuid?.replace('course_', '')}`;
    nameMap[uuid] = c.name;
  });

  const linkedSet = new Set(rawList);
  const available = courses.filter((c: any) => {
    const uuid = `course_${c.course_uuid?.replace('course_', '')}`;
    return !linkedSet.has(uuid);
  });

  // Sanar y Criar: getResponseMetadata never throws; report the real outcome.
  const handleAdd = async (resourceUuid: string) => {
    const res = await addGroupResource(orgId, group.id, resourceUuid, token);
    if (!res.success) {
      toast.error(describePaymentError(res.data, sc, 'groups.course_add_error'));
      return;
    }
    queryClient.invalidateQueries({ queryKey: resourceQueryKey });
    queryClient.invalidateQueries({ queryKey: ['offers', 'by-resource'] });
    queryClient.invalidateQueries({ queryKey: ['payments', orgId, 'access'] });
    setPickerOpen(false);
    toast.success(sc('groups.course_added'));
  };

  const handleRemove = async (resourceUuid: string) => {
    const res = await removeGroupResource(orgId, group.id, resourceUuid, token);
    if (!res.success) {
      toast.error(describePaymentError(res.data, sc, 'groups.course_remove_error'));
      return;
    }
    queryClient.invalidateQueries({ queryKey: resourceQueryKey });
    queryClient.invalidateQueries({ queryKey: ['offers', 'by-resource'] });
    queryClient.invalidateQueries({ queryKey: ['payments', orgId, 'access'] });
    toast.success(sc('groups.course_removed'));
  };

  return (
    <div className="space-y-2">
      {rawList.length === 0 ? (
        <p className="text-xs text-gray-400 italic py-1">{sc('groups.no_courses')}</p>
      ) : (
        <ul className="space-y-1">
          {rawList.map((uuid: string) => (
            <li key={uuid} className="flex items-center justify-between bg-indigo-50 rounded-lg px-3 py-2">
              <div className="flex items-center gap-2">
                <BookOpen size={13} className="text-indigo-500 shrink-0" />
                <span className="text-sm font-medium text-gray-800 truncate max-w-[200px]">
                  {nameMap[uuid] ?? uuid}
                </span>
              </div>
              <button
                onClick={() => handleRemove(uuid)}
                className="text-gray-300 hover:text-red-500 transition-colors ms-2 shrink-0"
                title={sc('common.remove')}
              >
                <X size={13} />
              </button>
            </li>
          ))}
        </ul>
      )}

      {/* Add picker */}
      {!pickerOpen ? (
        <button
          onClick={() => setPickerOpen(true)}
          className="flex items-center gap-1.5 text-xs font-medium text-indigo-600 hover:text-indigo-800 transition-colors py-1"
        >
          <Plus size={12} /> {sc('groups.add_course')}
        </button>
      ) : (
        <div className="border border-gray-200 rounded-lg bg-white shadow-sm">
          <div className="flex items-center justify-between px-3 py-2 border-b border-gray-100">
            <span className="text-xs font-semibold text-gray-600">{sc('groups.select_course')}</span>
            <button onClick={() => setPickerOpen(false)} className="text-gray-400 hover:text-gray-600">
              <X size={13} />
            </button>
          </div>
          {!coursesData ? (
            <p className="text-xs text-gray-400 px-3 py-2">{sc('common.loading')}</p>
          ) : available.length === 0 ? (
            <p className="text-xs text-gray-400 px-3 py-2 italic">{sc('groups.all_courses_in_group')}</p>
          ) : (
            <ul className="max-h-40 overflow-y-auto divide-y divide-gray-50">
              {available.map((c: any) => {
                const uuid = `course_${c.course_uuid?.replace('course_', '')}`;
                return (
                  <li key={uuid}>
                    <button
                      onClick={() => handleAdd(uuid)}
                      className="w-full text-start px-3 py-2 text-sm text-gray-700 hover:bg-indigo-50 flex items-center gap-2 transition-colors"
                    >
                      <BookOpen size={13} className="text-indigo-400 shrink-0" />
                      <span className="truncate">{c.name}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// UserGroup Sync Panel
// ---------------------------------------------------------------------------

function GroupSyncPanel({ group, orgId, token }: { group: any; orgId: number; token: string }) {
  const queryClient = useQueryClient();
  const { sc } = useScT();

  const syncQueryKey = ['payments', orgId, 'groups', group.id, 'sync'];

  const { data: syncs } = useQuery({
    queryKey: syncQueryKey,
    queryFn: () => getGroupSyncs(orgId, group.id, token),
    enabled: !!(orgId && token),
    staleTime: 60_000,
  });

  const { data: usergroups } = useQuery({
    queryKey: queryKeys.usergroups.list(orgId),
    queryFn: async () => {
      const { getUserGroups } = await import('@services/usergroups/usergroups');
      const res = await getUserGroups(orgId, token);
      return res?.data ?? res ?? [];
    },
    enabled: !!(orgId && token),
    staleTime: 60_000,
  });

  const syncList: any[] = Array.isArray(syncs?.data) ? syncs.data : Array.isArray(syncs) ? syncs : [];
  const syncedIds = new Set(syncList.map((s: any) => s.usergroup_id));
  const available = (usergroups ?? []).filter((ug: any) => !syncedIds.has(ug.id));

  const handleAdd = async (ugId: number) => {
    const res = await addGroupSync(orgId, group.id, ugId, token);
    if (!res.success) {
      toast.error(describePaymentError(res.data, sc, 'groups.sync_add_error'));
      return;
    }
    queryClient.invalidateQueries({ queryKey: syncQueryKey });
    toast.success(sc('groups.sync_added'));
  };

  const handleRemove = async (ugId: number) => {
    const res = await removeGroupSync(orgId, group.id, ugId, token);
    if (!res.success) {
      toast.error(describePaymentError(res.data, sc, 'groups.sync_remove_error'));
      return;
    }
    queryClient.invalidateQueries({ queryKey: syncQueryKey });
    toast.success(sc('groups.sync_removed'));
  };

  return (
    <div className="space-y-2">
      <p className="text-xs text-gray-400 leading-relaxed">
        {sc('groups.sync_help')}
      </p>

      {syncList.length > 0 && (
        <ul className="space-y-1">
          {syncList.map((s: any) => (
            <li key={s.usergroup_id} className="flex items-center justify-between bg-orange-50 rounded-lg px-3 py-2">
              <div className="flex items-center gap-2">
                <Users size={13} className="text-orange-500 shrink-0" />
                <span className="text-sm font-medium text-gray-800">{s.usergroup_name ?? sc('groups.usergroup_fallback', { id: s.usergroup_id })}</span>
              </div>
              <button
                onClick={() => handleRemove(s.usergroup_id)}
                className="text-gray-300 hover:text-red-500 transition-colors ms-2 shrink-0"
                title={sc('groups.remove_sync')}
              >
                <X size={13} />
              </button>
            </li>
          ))}
        </ul>
      )}

      {available.length > 0 ? (
        <div className="relative">
          <select
            className="w-full appearance-none text-xs border border-gray-200 rounded-lg px-3 py-2 bg-white text-gray-700 focus:outline-none focus:ring-2 focus:ring-orange-200 cursor-pointer pe-7"
            value=""
            onChange={(e) => { if (e.target.value) handleAdd(Number(e.target.value)); }}
          >
            <option value="">{sc('groups.link_usergroup')}</option>
            {available.map((ug: any) => (
              <option key={ug.id} value={ug.id}>{ug.name}</option>
            ))}
          </select>
          <ChevronDown size={12} className="pointer-events-none absolute end-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
        </div>
      ) : syncList.length === 0 ? (
        <p className="text-xs text-gray-400 italic">{sc('groups.no_usergroups')}</p>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Group Card
// ---------------------------------------------------------------------------

function GroupCard({ group, orgId, token, onEdit, onDelete }: {
  group: any; orgId: number; token: string;
  onEdit: (g: any) => void;
  onDelete: (id: number) => void;
}) {
  const { sc } = useScT();
  return (
    <div className="bg-white rounded-xl border border-gray-100 nice-shadow overflow-hidden flex flex-col">
      {/* Card header */}
      <div className="flex items-start justify-between px-4 pt-4 pb-3 border-b border-gray-50">
        <div className="flex items-start gap-2.5 min-w-0">
          <div className="mt-0.5 w-7 h-7 rounded-lg bg-indigo-50 flex items-center justify-center shrink-0">
            <Layers size={14} className="text-indigo-500" />
          </div>
          <div className="min-w-0">
            <h3 className="font-bold text-sm text-gray-900 leading-snug">{group.name}</h3>
            {group.description && (
              <p className="text-xs text-gray-400 mt-0.5 leading-relaxed">{group.description}</p>
            )}
          </div>
        </div>
        <div className="flex gap-1 shrink-0 ms-2">
          <button
            onClick={() => onEdit(group)}
            className="p-1.5 rounded-md text-gray-400 hover:text-blue-500 hover:bg-blue-50 transition-colors"
            title={sc('groups.edit')}
          >
            <Pencil size={13} />
          </button>
          <ConfirmationModal
            confirmationButtonText={sc('groups.delete')}
            confirmationMessage={sc('groups.delete_confirm')}
            dialogTitle={sc('groups.delete_title', { name: group.name })}
            dialogTrigger={
              <button className="p-1.5 rounded-md text-gray-400 hover:text-red-500 hover:bg-red-50 transition-colors" title={sc('groups.delete')}>
                <Trash2 size={13} />
              </button>
            }
            functionToExecute={() => onDelete(group.id)}
            status="warning"
          />
        </div>
      </div>

      <div className="flex flex-col divide-y divide-gray-50 flex-1">
        {/* Courses section */}
        <div className="px-4 py-3">
          <div className="flex items-center gap-1.5 mb-2.5">
            <BookOpen size={12} className="text-indigo-400" />
            <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide">{sc('groups.section_courses')}</span>
          </div>
          <GroupResourcePanel group={group} orgId={orgId} token={token} />
        </div>

        {/* UserGroup sync section */}
        <div className="px-4 py-3">
          <div className="flex items-center gap-1.5 mb-2.5">
            <RefreshCcw size={12} className="text-orange-400" />
            <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide">{sc('groups.section_access')}</span>
          </div>
          <GroupSyncPanel group={group} orgId={orgId} token={token} />
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Create / Edit form
// ---------------------------------------------------------------------------

function GroupForm({ initial, onSubmit, onCancel }: {
  initial?: { name: string; description: string };
  onSubmit: (data: { name: string; description: string }) => Promise<void>;
  onCancel: () => void;
}) {
  const { sc } = useScT();
  const [name, setName] = useState(initial?.name ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) { toast.error(sc('groups.name_required')); return; }
    setLoading(true);
    try {
      await onSubmit({ name: name.trim(), description: description.trim() });
    } finally {
      setLoading(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4 px-1.5 py-2">
      <div>
        <Label htmlFor="pg-name">{sc('groups.field_name')}</Label>
        <Input
          id="pg-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={sc('groups.field_name_placeholder')}
        />
      </div>
      <div>
        <Label htmlFor="pg-desc">{sc('groups.field_description')} <span className="text-gray-400">({sc('common.optional')})</span></Label>
        <Textarea
          id="pg-desc"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder={sc('groups.field_description_placeholder')}
          rows={3}
        />
      </div>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" className="rounded-full" onClick={onCancel}>{sc('common.cancel')}</Button>
        <Button type="submit" className="rounded-full bg-[#190933] text-white hover:bg-[#41375B]" disabled={loading}>
          {loading ? sc('common.saving') : initial ? sc('groups.save_changes') : sc('groups.create')}
        </Button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export default function PaymentsGroupsPage() {
  const org = useOrg() as any;
  const session = useLHSession() as any;
  const token = session?.data?.tokens?.access_token;
  const { isEnabled, isLoading } = usePaymentsEnabled();
  const queryClient = useQueryClient();
  const { sc } = useScT();

  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [editingGroup, setEditingGroup] = useState<any>(null);

  const { data: groups, error } = useQuery({
    queryKey: queryKeys.payments.groups(org?.id),
    queryFn: () => getPaymentsGroups(org.id, token),
    enabled: !!(org?.id && token),
    staleTime: 60_000,
  });

  if (!isEnabled && !isLoading) return <UnconfiguredPaymentsDisclaimer />;
  if (error) return <div className="p-8 text-sm text-red-500">{sc('groups.load_error')}</div>;
  if (!groups) return (
    <div className="ms-4 me-4 sm:ms-10 sm:me-10 mx-auto bg-white rounded-xl nice-shadow px-4 py-4 animate-pulse">
      <div className="flex items-center justify-between bg-gray-50 px-5 py-3 rounded-md mb-5">
        <div className="space-y-1.5">
          <div className="h-5 bg-gray-200 rounded w-36" />
          <div className="h-3 bg-gray-100 rounded w-64" />
        </div>
        <div className="h-8 bg-gray-200 rounded w-24" />
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {[1, 2, 3].map((i) => (
          <div key={i} className="bg-white rounded-xl border border-gray-100 p-4 space-y-3">
            <div className="h-5 bg-gray-200 rounded w-1/2" />
            <div className="h-3 bg-gray-100 rounded w-3/4" />
            <div className="h-3 bg-gray-100 rounded w-1/3" />
          </div>
        ))}
      </div>
    </div>
  );

  const list: any[] = Array.isArray(groups?.data) ? groups.data : Array.isArray(groups) ? groups : [];

  const handleCreate = async (data: { name: string; description: string }) => {
    const res = await createPaymentsGroup(org.id, data, token);
    if (res.success) {
      toast.success(sc('groups.created'));
      queryClient.invalidateQueries({ queryKey: queryKeys.payments.groups(org.id) });
      setIsCreateOpen(false);
    } else {
      toast.error(describePaymentError(res.data, sc, 'groups.create_error'));
    }
  };

  const handleUpdate = async (data: { name: string; description: string }) => {
    if (!editingGroup) return;
    const res = await updatePaymentsGroup(org.id, editingGroup.id, data, token);
    if (res.success) {
      toast.success(sc('groups.updated'));
      queryClient.invalidateQueries({ queryKey: queryKeys.payments.groups(org.id) });
      setEditingGroup(null);
    } else {
      toast.error(describePaymentError(res.data, sc, 'groups.update_error'));
    }
  };

  const handleDelete = async (groupId: number) => {
    const res = await deletePaymentsGroup(org.id, groupId, token);
    if (res.success || res.status === 200) {
      toast.success(sc('groups.deleted'));
      queryClient.invalidateQueries({ queryKey: queryKeys.payments.groups(org.id) });
      queryClient.invalidateQueries({ queryKey: queryKeys.payments.offers(org.id) });
    } else {
      toast.error(describePaymentError(res.data, sc, 'groups.delete_error'));
    }
  };

  return (
    <div className="ms-4 me-4 sm:ms-10 sm:me-10 mx-auto bg-white rounded-xl nice-shadow px-4 py-4">
      <Modal
        isDialogOpen={isCreateOpen}
        onOpenChange={setIsCreateOpen}
        dialogTitle={sc('groups.create_title')}
        dialogDescription={sc('groups.create_description')}
        dialogContent={
          <GroupForm onSubmit={handleCreate} onCancel={() => setIsCreateOpen(false)} />
        }
      />
      <Modal
        isDialogOpen={!!editingGroup}
        onOpenChange={(open) => { if (!open) setEditingGroup(null); }}
        dialogTitle={sc('groups.edit_title')}
        dialogDescription={sc('groups.edit_description')}
        dialogContent={
          editingGroup ? (
            <GroupForm
              initial={{ name: editingGroup.name, description: editingGroup.description }}
              onSubmit={handleUpdate}
              onCancel={() => setEditingGroup(null)}
            />
          ) : null
        }
      />

      {/* Page header */}
      <div className="flex flex-wrap gap-2 items-center justify-between bg-[#EEEDFF]/60 px-5 py-3 rounded-md mb-5">
        <div className="-space-y-0.5">
          <h1 className="font-bold text-xl text-[#190933]">{sc('groups.title')}</h1>
          <p className="text-[#584F72] text-sm">{sc('groups.subtitle')}</p>
        </div>
        <Button onClick={() => setIsCreateOpen(true)} size="sm" className="rounded-full bg-[#190933] text-white hover:bg-[#41375B]">
          <Plus size={14} className="me-1.5" /> {sc('groups.new_group')}
        </Button>
      </div>

      {list.length === 0 ? (
        <div className="border border-dashed border-gray-200 rounded-xl p-12 text-center">
          <div className="w-12 h-12 bg-indigo-50 rounded-xl flex items-center justify-center mx-auto mb-3">
            <Layers size={22} className="text-indigo-300" />
          </div>
          <p className="font-semibold text-gray-600 mb-1">{sc('groups.empty_title')}</p>
          <p className="text-sm text-gray-400 mb-4 max-w-xs mx-auto">
            {sc('groups.empty_description')}
          </p>
          <Button onClick={() => setIsCreateOpen(true)} variant="outline" size="sm" className="rounded-full">
            <Plus size={13} className="me-1.5" /> {sc('groups.create_first')}
          </Button>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {list.map((group: any) => (
            <GroupCard
              key={group.id}
              group={group}
              orgId={org.id}
              token={token}
              onEdit={setEditingGroup}
              onDelete={handleDelete}
            />
          ))}
        </div>
      )}
    </div>
  );
}
