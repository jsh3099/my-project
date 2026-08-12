'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { MapPin } from 'lucide-react'
import { updateSiteAddress } from '@/actions/sites'

interface Props {
  siteId: string
  siteName: string
  address: string // 저장된 현장주소 (없으면 '')
}

// 대시보드 현장 정보 카드 — 현장주소의 단일 입력 지점.
// 여기서 한 번 저장하면 sites.address로 남아 주재비 교통비·출장비 산출의
// 현장주소로 자동 매핑된다 (산출 패널에서는 읽기 전용으로 표시).
export function SiteAddressCard({ siteId, siteName, address }: Props) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState(address)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)

  function handleSave() {
    setError('')
    const fd = new FormData()
    fd.set('address', value)
    startTransition(async () => {
      const res = await updateSiteAddress(siteId, fd)
      if ('error' in res) {
        setError(res.error)
      } else {
        setEditing(false)
        setSaved(true)
        setTimeout(() => setSaved(false), 2500)
        router.refresh()
      }
    })
  }

  return (
    <div className={`flex flex-wrap items-center gap-2 rounded-xl border p-4 ${
      address ? 'border-gray-200 bg-white' : 'border-amber-200 bg-amber-50'
    }`}>
      <MapPin className={`h-4 w-4 flex-none ${address ? 'text-gray-400' : 'text-amber-500'}`} aria-hidden="true" />
      <span className="text-sm font-semibold text-gray-900">{siteName}</span>

      {editing || !address ? (
        <>
          <input
            type="text"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="현장주소 입력 — 예: 충북 청주시 상당구 ○○로 123"
            className="min-w-[220px] flex-1 rounded-lg border border-gray-300 px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none"
          />
          <button
            type="button" onClick={handleSave} disabled={isPending || !value.trim()}
            className="rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {isPending ? '저장 중…' : '주소 저장'}
          </button>
          {editing && (
            <button
              type="button" onClick={() => { setEditing(false); setValue(address) }}
              className="rounded-lg border border-gray-300 px-3 py-1.5 text-xs font-semibold text-gray-600 hover:bg-gray-50"
            >
              취소
            </button>
          )}
          {!address && (
            <span className="w-full text-xs text-amber-600">
              현장주소가 없으면 교통비·출장비 자동 산출(카카오 길찾기)을 쓸 수 없습니다. 한 번만 입력하면 모든 산출에 자동 반영됩니다.
            </span>
          )}
        </>
      ) : (
        <>
          <span className="text-sm text-gray-600">{address}</span>
          {saved && <span className="text-xs font-semibold text-green-600">✓ 저장됨</span>}
          <button
            type="button" onClick={() => { setEditing(true); setValue(address) }}
            className="ml-auto rounded-lg border border-gray-200 px-2.5 py-1 text-xs text-gray-500 hover:bg-gray-50"
          >
            수정
          </button>
          <span className="w-full text-[11px] text-gray-400">
            교통비·출장비 산출의 현장주소로 자동 사용됩니다.
          </span>
        </>
      )}

      {error && <span className="w-full text-xs text-red-600">{error}</span>}
    </div>
  )
}
