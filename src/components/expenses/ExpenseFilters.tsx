'use client'

import { useRouter } from 'next/navigation'
import type { Site } from '@/types'

interface SiteSelectProps {
  sites: Site[]
  selectedSiteId: string
  ym: string
}

export function SiteSelect({ sites, selectedSiteId, ym }: SiteSelectProps) {
  const router = useRouter()
  return (
    <select
      defaultValue={selectedSiteId}
      className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm"
      onChange={(e) => {
        router.push(`/expenses?site=${e.target.value}&month=${ym}`)
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
