'use client'

import { useRouter } from 'next/navigation'
import type { Site } from '@/types'

interface SiteSelectProps {
  sites: Site[]
  selectedSiteId: string
  /** 월 필터가 있는 화면(입력 내역)만 사용 — 없으면 site만 붙인다 */
  ym?: string
  /** 이동할 화면. 대시보드처럼 월 필터가 없는 화면에서도 쓰려고 받는다 */
  basePath?: string
}

export function SiteSelect({ sites, selectedSiteId, ym, basePath = '/expenses' }: SiteSelectProps) {
  const router = useRouter()
  return (
    <select
      defaultValue={selectedSiteId}
      aria-label="현장 선택"
      className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm"
      onChange={(e) => {
        const q = new URLSearchParams({ site: e.target.value })
        if (ym) q.set('month', ym)
        router.push(`${basePath}?${q}`)
      }}
    >
      {sites.map((s) => (
        <option key={s.id} value={s.id}>{s.name}</option>
      ))}
    </select>
  )
}

interface MonthSelectProps {
  ym: string
  siteId: string
}

export function MonthSelect({ ym, siteId }: MonthSelectProps) {
  const router = useRouter()
  const months: string[] = []
  const now = new Date()
  for (let i = 0; i < 6; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1)
    months.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`)
  }

  return (
    <select
      defaultValue={ym}
      className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm"
      onChange={(e) => {
        router.push(`/expenses?month=${e.target.value}${siteId ? `&site=${siteId}` : ''}`)
      }}
    >
      {months.map((m) => (
        <option key={m} value={m}>{m.replace('-', '년 ')}월</option>
      ))}
    </select>
  )
}
