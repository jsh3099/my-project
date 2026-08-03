'use client'

import { useState } from 'react'

interface Props {
  siteId: string
  roundId?: string | null
  label?: string
  /** 출력 형식 — excel(기본) 또는 pdf (F-22) */
  format?: 'excel' | 'pdf'
}

// 정산서 엑셀·PDF 다운로드 버튼 — fetch → blob 방식 (실패 시 서버 에러 메시지 표시)
export function ReportDownloadButton({ siteId, roundId, label, format = 'excel' }: Props) {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const buttonLabel = label ?? (format === 'pdf' ? '📄 정산서 PDF' : '📄 정산서 엑셀')

  async function handleDownload() {
    setLoading(true)
    setError('')
    try {
      const params = new URLSearchParams({ site: siteId })
      if (roundId) params.set('round', roundId)
      const res = await fetch(`/api/reports/${format === 'pdf' ? 'pdf' : 'excel'}?${params}`)
      if (!res.ok) {
        const body = await res.json().catch(() => null)
        throw new Error(body?.error ?? `다운로드 실패 (${res.status})`)
      }
      const blob = await res.blob()
      const disposition = res.headers.get('Content-Disposition') ?? ''
      const match = disposition.match(/filename\*=UTF-8''([^;]+)/)
      const fileName = match ? decodeURIComponent(match[1]) : format === 'pdf' ? '정산서.pdf' : '정산서.xlsx'
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = fileName
      a.click()
      URL.revokeObjectURL(url)
    } catch (e) {
      setError(e instanceof Error ? e.message : '다운로드 중 오류가 발생했습니다.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <span className="inline-flex flex-col items-start gap-0.5">
      <button
        type="button"
        onClick={handleDownload}
        disabled={loading}
        className={
          format === 'pdf'
            ? 'rounded-md border border-rose-300 bg-rose-50 px-2.5 py-1 text-xs font-medium text-rose-700 hover:bg-rose-100 disabled:opacity-50'
            : 'rounded-md border border-green-300 bg-green-50 px-2.5 py-1 text-xs font-medium text-green-700 hover:bg-green-100 disabled:opacity-50'
        }
      >
        {loading ? '생성 중...' : buttonLabel}
      </button>
      {error && <span className="text-xs text-red-600">{error}</span>}
    </span>
  )
}
