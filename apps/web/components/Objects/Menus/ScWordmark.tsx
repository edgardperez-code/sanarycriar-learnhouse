// Sanar y Criar: text wordmark (brand manual p.3 uses no image logo).
// "Sanar y Criar" in Playfair Display with the "y" in italic, plus the
// professional line in Poppins. Mirrors sanarycriar/web Wordmark.astro.
import React from 'react'
import { SC_PROFESSIONAL } from './scBrand'

interface ScWordmarkProps {
  tone?: 'dark' | 'light'
  size?: 'sm' | 'md' | 'lg'
  subtitle?: boolean
  className?: string
}

const TITLE_SIZE = {
  sm: 'text-[1.125rem]',
  md: 'text-[1.25rem] sm:text-[1.375rem]',
  lg: 'text-[2rem] sm:text-[2.25rem]',
}

const SUBTITLE_SIZE = {
  sm: 'text-[0.625rem]',
  md: 'text-[0.6875rem]',
  lg: 'text-[0.8125rem]',
}

export default function ScWordmark({ tone = 'dark', size = 'md', subtitle = true, className = '' }: ScWordmarkProps) {
  const light = tone === 'light'
  return (
    <span className={`inline-flex flex-col ${className}`}>
      <span
        className={`font-display font-semibold leading-none tracking-[-0.015em] whitespace-nowrap ${TITLE_SIZE[size]} ${light ? 'text-nube' : 'text-violeta'}`}
      >
        Sanar <em className={`font-medium ${light ? 'text-rosa-300' : 'text-lavanda-500'}`}>y</em> Criar
      </span>
      {subtitle && (
        <span
          className={`mt-1 font-medium leading-tight tracking-[0.02em] whitespace-nowrap ${SUBTITLE_SIZE[size]} ${light ? 'text-nube/75' : 'text-violeta-500'}`}
        >
          {SC_PROFESSIONAL.name} · {SC_PROFESSIONAL.shortTitle}
        </span>
      )}
    </span>
  )
}
