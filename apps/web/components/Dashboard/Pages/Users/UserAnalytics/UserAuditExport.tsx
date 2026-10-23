'use client'
import React, { useState, useRef, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Download, ChevronDown } from 'lucide-react'
import toast from 'react-hot-toast'
import { getAPIUrl } from '@services/config/config'
import { useLHSession } from '@components/Contexts/LHSessionContext'
import { useOrg } from '@components/Contexts/OrgContext'
import { fullName, fmtDuration } from './format'
import { formatDate, formatDateTime } from '@/lib/format'

type Fmt = 'csv' | 'json' | 'pdf'

interface Props {
  userIds: number[]
  days?: number
  // When exporting a single already-loaded dossier, reuse it for PDF instead of refetching.
  defaultDossier?: any
  label?: string
}

// Beyond this a single task's answers stop being a report and start being a dump.
const MAX_PDF_ANSWERS_PER_TASK = 50

function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

type Translate = (_key: string, _options?: Record<string, unknown>) => string

// Sanar y Criar: dates in the UI language (./format's helpers are en-US only).
function safeFormat(value: string | null | undefined, fmt: (_d: Date) => string, fallback: string): string {
  if (!value) return fallback
  const d = new Date(value)
  return isNaN(d.getTime()) ? fallback : fmt(d)
}

/**
 * Build a legal-style, multi-page text PDF from one or more dossiers.
 *
 * Sanar y Criar: every fixed string is translated (sc_ui.audit_export.*, plus
 * the dossier's own status / task-type labels).
 */
async function buildPdf(dossiers: any[], tr: Translate, lng: string) {
  const { default: jsPDF } = await import('jspdf')
  const pdf = new jsPDF('portrait', 'mm', 'a4')
  const margin = 14
  const pageWidth = pdf.internal.pageSize.getWidth()
  const pageHeight = pdf.internal.pageSize.getHeight()
  let y = margin

  const ax = (key: string, options?: Record<string, unknown>) => tr(`sc_ui.audit_export.${key}`, options)
  const na = tr('sc_ui.common.not_available')
  const date = (v: string | null | undefined) => safeFormat(v, (d) => formatDate(d, lng), na)
  const dateTime = (v: string | null | undefined) => safeFormat(v, (d) => formatDateTime(d, lng), na)
  const yesNo = (value: boolean) => tr(value ? 'sc_ui.common.yes' : 'sc_ui.common.no')
  // Same lookup as the dossier's StatusBadge ("STATUS_IN_PROGRESS" -> status.in_progress).
  const statusLabel = (status?: string) => {
    const key = status?.replace('STATUS_', '').toLowerCase()
    return key ? tr(`dashboard.users.analytics.status.${key}`, { defaultValue: key.replace('_', ' ') }) : na
  }
  const taskTypeLabel = (tk: any) =>
    tk.type
      ? tr(`dashboard.users.analytics.task_types.${tk.type}`, { defaultValue: tk.type_label || tk.type })
      : tk.type_label || ''

  const breakIfNeeded = (height: number) => {
    if (y + height > pageHeight - margin) {
      pdf.addPage()
      y = margin
    }
  }

  const line = (text: string, size = 10, bold = false, indent = 0) => {
    pdf.setFontSize(size)
    pdf.setFont('helvetica', bold ? 'bold' : 'normal')
    const wrapped = pdf.splitTextToSize(text || '', pageWidth - margin * 2 - indent)
    // Measure before deciding on the page break: checking only the current y let a
    // wrapped paragraph start near the bottom and run off the page.
    const height = wrapped.length * (size * 0.45) + 1.5
    breakIfNeeded(height)
    pdf.text(wrapped, margin + indent, y)
    y += height
  }
  const gap = (h = 3) => { y += h }
  const heading = (text: string) => {
    gap(2)
    // Keep the heading with at least one line of its section.
    breakIfNeeded(14)
    line(text, 13, true)
    gap(1)
  }

  dossiers.forEach((d, idx) => {
    if (idx > 0) { pdf.addPage(); y = margin }
    const u = d.user || {}
    const s = d.summary || {}
    const sec = d.security || {}

    line(ax('report_title'), 18, true)
    line(fullName(u) + `  (@${u.username})`, 12)
    line(u.email || '', 10)
    line(ax('generated', { date: dateTime(new Date().toISOString()) }), 9)
    line(ax('internal_note'), 9)
    gap(2)

    heading(ax('summary'))
    line(ax('courses_enrolled', { enrolled: s.courses_enrolled ?? 0, completed: s.courses_completed ?? 0 }), 10)
    line(ax('avg_progress', { pct: s.avg_progress_pct ?? 0 }), 10)
    line(ax('assignments_submitted', { count: s.assignments_submitted ?? 0 }) + (s.avg_grade_pct != null ? ax('avg_grade', { pct: s.avg_grade_pct }) : ''), 10)
    line(ax('certificates_earned', { count: s.certificates_earned ?? 0 }), 10)
    line(ax('connections_recorded', { count: s.connections ?? 0, date: date(s.last_connection) }), 10)

    heading(ax('account_security'))
    line(ax('email_verified', { value: yesNo(!!sec.email_verified), method: sec.signup_method || na }), 10)
    line(ax('last_login', { date: dateTime(sec.last_login_at), ip: sec.last_login_ip || na }), 10)

    heading(ax('connections'))
    ;(d.connections || []).slice(0, 100).forEach((c: any) => {
      line(`${dateTime(c.at)}  ${c.event_label || c.event_type}  ${c.ip || ''}  ${c.device || ''}  ${c.method || ''}`, 9)
    })
    if ((d.connections || []).length === 0) line(ax('none_recorded'), 9)

    heading(ax('course_progress'))
    ;(d.courses || []).forEach((c: any) => {
      line(`${c.course_name || ax('untitled_course')}: ${c.progress_pct}% (${c.activities_completed}/${c.activities_total}), ${statusLabel(c.status)}`, 9)
    })
    if ((d.courses || []).length === 0) line(ax('no_enrollments'), 9)

    heading(ax('assignments'))
    ;(d.assignments || []).forEach((a: any) => {
      const grade = a.grade_display || (a.grade != null ? String(a.grade) : na)
      line(`${a.title || a.assignment_uuid}: ${grade}${a.points_summary ? ` (${a.points_summary})` : ''}, ${statusLabel(a.status)}, ${ax('attempt', { number: a.attempt_number })}`, 9)
      if (a.course_name) line(ax('course', { name: a.course_name }), 8, false, 4)
      ;(a.tasks || []).forEach((tk: any) => {
        const points = tk.submitted ? (tk.points_summary || `${tk.grade}`) : ax('not_submitted')
        const typeLabel = taskTypeLabel(tk)
        line(`${ax('task', { index: tk.index })} (${typeLabel}${tk.title ? `: ${tk.title}` : ''}): ${points}${tk.manually_graded ? ax('manually_graded') : ''}`, 9, true, 4)
        const answer = tk.answer
        if (!answer) return
        if (answer.kind === 'code' && answer.code) {
          // Source code belongs in the JSON export, not in a printable report.
          line(ax('tests_passed', { language: answer.code.language || ax('code'), passed: answer.code.passed_tests, total: answer.code.total_tests }), 8, false, 8)
          return
        }
        ;(answer.items || []).slice(0, MAX_PDF_ANSWERS_PER_TASK).forEach((item: any) => {
          line(ax('question', { text: item.prompt }), 8, false, 8)
          const verdict = item.correct === true ? `  ${ax('correct')}` : item.correct === false ? `  ${ax('wrong')}` : ''
          line(`${ax('answer', { text: item.answer_text || ax('no_answer') })}${verdict}`, 8, false, 8)
          if (item.expected_text && item.expected_text !== item.answer_text) {
            line(ax('expected', { text: item.expected_text }), 8, false, 8)
          }
        })
        const hidden = (answer.items || []).length - MAX_PDF_ANSWERS_PER_TASK
        if (hidden > 0) line(ax('omitted', { count: hidden }), 8, false, 8)
      })
    })
    if ((d.assignments || []).length === 0) line(ax('no_submissions'), 9)

    heading(ax('code_exercises'))
    ;(d.code_submissions || []).slice(0, 100).forEach((cs: any) => {
      const result = cs.result_label || (cs.passed ? ax('passed') : ax('failed_result'))
      const tests = ax('tests', { summary: cs.tests_summary || `${cs.passed_tests}/${cs.total_tests}` })
      line(`${cs.activity_name || ax('untitled_activity')}${cs.course_name ? ` (${cs.course_name})` : ''}: ${cs.language || na}, ${result}, ${tests}, ${dateTime(cs.created_at)}`, 9)
    })
    if ((d.code_submissions || []).length === 0) line(ax('none'), 9)

    heading(ax('community'))
    const discussions = d.community?.discussions || []
    const comments = d.community?.comments || []
    discussions.slice(0, 100).forEach((disc: any) => {
      line(ax('discussion', { title: disc.title, date: date(disc.created_at) }), 9)
    })
    comments.slice(0, 100).forEach((c: any) => {
      line(ax('comment_in', { title: c.discussion_title || ax('untitled'), text: c.excerpt || c.content || '' }), 9)
    })
    if (discussions.length === 0 && comments.length === 0) line(ax('no_community'), 9)

    heading(ax('certificates'))
    ;(d.certificates || []).forEach((c: any) => {
      line(`${c.course_name} (${date(c.created_at)})`, 9)
      line(ax('credential', { id: c.credential_id || c.user_certification_uuid }), 8, false, 4)
    })
    if ((d.certificates || []).length === 0) line(ax('none'), 9)

    const totalSeconds = Number(d.behavior?.user_time_total?.[0]?.total_seconds || 0)
    heading(ax('behavior'))
    line(ax('total_time', { time: fmtDuration(totalSeconds) }), 9)
    ;(d.behavior?.user_time_by_course || []).slice(0, 50).forEach((b: any) => {
      line(`${b.course_name || ax('untitled_course')}: ${fmtDuration(b.total_seconds)}`, 9, false, 4)
    })
    const searches = (d.behavior?.user_searches || []).slice(0, 20)
    if (searches.length > 0) {
      line(ax('searches', { list: searches.map((q: any) => `${q.query} (${q.count})`).join(', ') }), 9)
    }
  })

  const name = dossiers.length === 1
    ? `audit-${dossiers[0]?.user?.username || dossiers[0]?.user?.id}.pdf`
    : `audit-${dossiers.length}-students.pdf`
  pdf.save(name)
}

export default function UserAuditExport({ userIds, days = 365, defaultDossier, label }: Props) {
  const { t, i18n } = useTranslation()
  const session = useLHSession() as any
  const org = useOrg() as any
  const token = session?.data?.tokens?.access_token
  const orgId = org?.id

  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [includeRaw, setIncludeRaw] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function onOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onOutside)
    return () => document.removeEventListener('mousedown', onOutside)
  }, [])

  const ids = userIds.filter((id) => !!id)

  async function handle(fmt: Fmt) {
    if (!orgId || !token || busy || ids.length === 0) return
    setBusy(true)
    setOpen(false)
    try {
      const params = new URLSearchParams({
        org_id: String(orgId),
        user_ids: ids.join(','),
        days: String(days),
      })
      // Off by default: the readable rendering is what a reader wants, and the raw
      // payloads roughly double the file.
      if (includeRaw) params.set('include_raw', 'true')

      if (fmt === 'csv') {
        params.set('format', 'csv')
        const resp = await fetch(`${getAPIUrl()}audit/export?${params}`, {
          headers: { Authorization: `Bearer ${token}` },
        })
        if (!resp.ok) throw new Error(`${resp.status}`)
        triggerDownload(await resp.blob(), ids.length === 1 ? `audit-user-${ids[0]}.csv` : `audit-${ids.length}-users.csv`)
        return
      }

      // JSON + PDF both need the JSON dossiers.
      let dossiers: any[]
      if (fmt === 'pdf' && defaultDossier && ids.length === 1 && !includeRaw) {
        dossiers = [defaultDossier]
      } else {
        params.set('format', 'json')
        const resp = await fetch(`${getAPIUrl()}audit/export?${params}`, {
          headers: { Authorization: `Bearer ${token}` },
        })
        if (!resp.ok) throw new Error(`${resp.status}`)
        dossiers = (await resp.json()).data || []
      }

      if (fmt === 'json') {
        triggerDownload(
          new Blob([JSON.stringify(dossiers, null, 2)], { type: 'application/json' }),
          ids.length === 1 ? `audit-user-${ids[0]}.json` : `audit-${ids.length}-users.json`
        )
      } else {
        await buildPdf(dossiers, (key, options) => String(t(key, options)), i18n?.language || 'es')
      }
    } catch (err) {
      console.error('Audit export failed:', err)
      // Sanar y Criar: tell the admin instead of failing silently.
      toast.error(t('sc_ui.audit_export.failed'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div ref={ref} className="relative flex-shrink-0">
      <button
        onClick={() => setOpen((o) => !o)}
        disabled={busy || ids.length === 0}
        className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium rounded-lg bg-gray-900 text-white hover:bg-gray-800 transition-colors disabled:opacity-50"
      >
        <Download size={15} />
        {busy ? t('dashboard.users.analytics.exporting') : label || t('dashboard.users.analytics.export')}
        {!busy && <ChevronDown size={12} />}
      </button>
      {open && (
        <div className="absolute end-0 mt-1 bg-white border border-gray-200 rounded-lg shadow-lg z-30 min-w-[190px] overflow-hidden">
          {(['pdf', 'csv', 'json'] as Fmt[]).map((f) => (
            <button
              key={f}
              onClick={() => handle(f)}
              className="w-full text-start px-3 py-2 text-xs font-medium text-gray-700 hover:bg-gray-50 uppercase"
            >
              {f}
            </button>
          ))}
          <label className="flex items-start gap-2 px-3 py-2 text-[11px] text-gray-500 border-t border-gray-100 cursor-pointer">
            <input
              type="checkbox"
              checked={includeRaw}
              onChange={(e) => setIncludeRaw(e.target.checked)}
              className="mt-0.5"
            />
            {t('dashboard.users.analytics.export_include_raw', {
              defaultValue: 'Include raw submission data',
            })}
          </label>
        </div>
      )}
    </div>
  )
}
