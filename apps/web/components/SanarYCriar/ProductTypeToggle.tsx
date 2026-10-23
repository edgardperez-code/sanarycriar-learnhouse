'use client'

// Sanar y Criar: "Tipo de producto: Curso / Ebook" in the course's general
// settings. Stored as course.extra_metadata.product_type; the other
// extra_metadata keys are kept (the API replaces the field wholesale).
import React from 'react'
import { BookOpen, PlayCircle } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useCourseFieldSync } from '@components/Contexts/CourseContext'

type ProductType = 'course' | 'ebook'

export default function ProductTypeToggle() {
  const { t } = useTranslation()
  const { syncChanges, courseStructure, isSaving } = useCourseFieldSync('scProductType')
  const extra = courseStructure?.extra_metadata
  const current: ProductType = extra?.product_type === 'ebook' ? 'ebook' : 'course'

  const select = (value: ProductType) => {
    if (value === current || isSaving) return
    const base = extra && typeof extra === 'object' && !Array.isArray(extra) ? extra : {}
    syncChanges({ extra_metadata: { ...base, product_type: value } }, true)
  }

  const options: { value: ProductType; label: string; icon: React.ReactNode }[] = [
    { value: 'course', label: t('sc_learning.product_type.course', 'Curso'), icon: <PlayCircle size={16} strokeWidth={1.75} /> },
    { value: 'ebook', label: t('sc_learning.product_type.ebook', 'Ebook'), icon: <BookOpen size={16} strokeWidth={1.75} /> },
  ]

  return (
    <div className="space-y-2">
      <div className="text-sm font-semibold text-gray-700" id="sc-product-type-label">
        {t('sc_learning.product_type.label', 'Tipo de producto')}
      </div>
      <div
        role="radiogroup"
        aria-labelledby="sc-product-type-label"
        className="inline-flex rounded-full border border-[#EAE8F2] bg-[#FDF5EE] p-1"
      >
        {options.map((option) => {
          const active = option.value === current
          return (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={active}
              disabled={isSaving}
              onClick={() => select(option.value)}
              className={`inline-flex items-center gap-2 rounded-full px-4 py-2 text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#7D75E2] disabled:opacity-60 ${
                active ? 'bg-[#190933] text-[#FDF5EE] shadow-sm' : 'text-[#584F72] hover:bg-[#EEEDFF] hover:text-[#190933]'
              }`}
            >
              {option.icon}
              {option.label}
            </button>
          )
        })}
      </div>
      <p className="text-xs leading-relaxed text-gray-500">
        {current === 'ebook'
          ? t(
              'sc_learning.product_type.help_ebook',
              'La página muestra la portada, la descripción y los botones "Leer ahora" y "Descargar PDF" en lugar de la lista de lecciones. Agrega una actividad de documento PDF con el libro.'
            )
          : t('sc_learning.product_type.help_course', 'Curso con lecciones en video, progreso y "Continuar donde lo dejaste".')}
      </p>
    </div>
  )
}
