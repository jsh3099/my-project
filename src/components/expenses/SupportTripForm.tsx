'use client'

// 기술지원 기술인 출장비 입력 — 정산서 2-1 서식
// 방문일별: 왕복 유류비(거리÷연비×당일유가) + 통행료 + 일비 + 식비 (공무원 여비규정)
// 인원별 거리·유종·통행료는 공통(본사↔현장), 유가만 방문일별로 다르다.

import { useState, useTransition, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { createSupportTrips, type SupportTripRow } from '@/actions/expenses'
import type { Profile, AttendanceRecord, SiteStaffMember } from '@/types'
import { SPECIALTIES, VEHICLE_FUEL_TYPE_LABELS, FUEL_EFFICIENCY, type VehicleFuelType } from '@/lib/constants'
import { calcTripVisit } from '@/lib/settlement'

interface Props {
  siteId: string
  siteName: string
  yearMonth: string
  users: Profile[]
  members: SiteStaffMember[]      // 현장 기술인 명부 (로그인 계정 없음 — 출근부 화면에서 등록)
  attendance: AttendanceRecord[]  // 출근부 방문일자 — 방문일 프리필 기준
  siteAddress?: string | null
  tripDailyAllowance?: number
  tripMealAllowance?: number
}

const ACCEPT = '.jpg,.jpeg,.png,.pdf'
const MAX_SIZE = 10 * 1024 * 1024

type Visit = { date: string; fuelPrice: string; fuelPriceDate: string; toll: string }
type PersonRow = {
  id: string
  userId: string
  name: string
  specialty: string
  originAddress: string
  distanceOneway: string
  fuelType: VehicleFuelType
  visits: Visit[]
  mapFile: File | null
}

let rowSeq = 0

function parseNum(v: string) { return parseInt(v.replace(/,/g, ''), 10) || 0 }

export function SupportTripForm({ siteId, siteName, yearMonth, users, members, attendance, siteAddress, tripDailyAllowance = 25000, tripMealAllowance = 25000 }: Props) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)

  // 출근부 방문일자 → 방문일 프리필 (유가·통행료는 입력)
  const visitDatesOf = (key: { user_id?: string; member_id?: string }): Visit[] => {
    const rec = attendance.find((a) => (key.user_id ? a.user_id === key.user_id : a.member_id === key.member_id))
    return (rec?.visit_dates ?? []).map((date) => ({ date, fuelPrice: '', fuelPriceDate: '', toll: '' }))
  }

  const [rows, setRows] = useState<PersonRow[]>([
    ...users.map((u, i) => ({
      id: u.id, userId: u.id, name: u.full_name,
      specialty: SPECIALTIES[i % SPECIALTIES.length],
      originAddress: '', distanceOneway: '', fuelType: 'gasoline' as VehicleFuelType,
      visits: visitDatesOf({ user_id: u.id }), mapFile: null,
    })),
    // 명부 인원 — 계정이 없으므로 이름으로 식별 (userId='')
    ...members.map((m, i) => ({
      id: `m_${m.id}`, userId: '', name: m.name,
      specialty: m.specialty && (SPECIALTIES as readonly string[]).includes(m.specialty)
        ? m.specialty
        : SPECIALTIES[(users.length + i) % SPECIALTIES.length],
      originAddress: '', distanceOneway: '', fuelType: 'gasoline' as VehicleFuelType,
      visits: visitDatesOf({ member_id: m.id }), mapFile: null,
    })),
  ])
  const [openRows, setOpenRows] = useState<Set<string>>(
    new Set([...users.map((u) => u.id), ...members.map((m) => `m_${m.id}`)])
  )
  const fileInputs = useRef<Record<string, HTMLInputElement | null>>({})

  function patchRow(id: string, patch: Partial<PersonRow>) {
    setRows((p) => p.map((r) => r.id === id ? { ...r, ...patch } : r))
  }

  function patchVisit(rowId: string, idx: number, patch: Partial<Visit>) {
    setRows((p) => p.map((r) => {
      if (r.id !== rowId) return r
      return { ...r, visits: r.visits.map((v, i) => i === idx ? { ...v, ...patch } : v) }
    }))
  }

  function addVisit(rowId: string) {
    setRows((p) => p.map((r) => {
      if (r.id !== rowId) return r
      const last = r.visits[r.visits.length - 1]
      return { ...r, visits: [...r.visits, { date: '', fuelPrice: last?.fuelPrice ?? '', fuelPriceDate: '', toll: last?.toll ?? '' }] }
    }))
  }

  function removeVisit(rowId: string, idx: number) {
    setRows((p) => p.map((r) => r.id === rowId ? { ...r, visits: r.visits.filter((_, i) => i !== idx) } : r))
  }

  function addPerson() {
    const id = `extra_trip_${++rowSeq}`
    setRows((p) => [...p, { id, userId: '', name: '', specialty: '건축', originAddress: '', distanceOneway: '', fuelType: 'gasoline', visits: [], mapFile: null }])
    setOpenRows((p) => new Set(p).add(id))
  }

  function removePerson(id: string) {
    setRows((p) => p.filter((r) => r.id !== id))
  }

  function toggleOpen(id: string) {
    setOpenRows((p) => {
      const n = new Set(p)
      if (n.has(id)) n.delete(id); else n.add(id)
      return n
    })
  }

  // 방문일별 산출 (미리보기 — 서버가 동일 함수로 재계산)
  function visitCalc(r: PersonRow, v: Visit) {
    const dist = parseFloat(r.distanceOneway) || 0
    const price = parseNum(v.fuelPrice)
    if (dist <= 0 || price <= 0) return null
    return calcTripVisit({
      distanceOnewayKm: dist,
      fuelEfficiency: FUEL_EFFICIENCY[r.fuelType].value,
      fuelPrice: price,
      toll: parseNum(v.toll),
      dailyAllowance: tripDailyAllowance,
      mealAllowance: tripMealAllowance,
    })
  }

  function rowTotal(r: PersonRow) {
    return r.visits.reduce((s, v) => s + (visitCalc(r, v)?.total ?? 0), 0)
  }

  const grandTotal = rows.reduce((s, r) => s + rowTotal(r), 0)
  const [year, mon] = yearMonth.split('-')

  function handleSave() {
    setError(null)
    const payload: SupportTripRow[] = rows
      .filter((r) => r.visits.some((v) => v.date))
      .map((r) => ({
        rowId: r.id,
        userId: r.userId,
        userName: r.name || '(추가)',
        specialty: r.specialty,
        originAddress: r.originAddress || null,
        distanceOnewayKm: parseFloat(r.distanceOneway) || 0,
        fuelType: r.fuelType,
        visits: r.visits
          .filter((v) => v.date)
          .map((v) => ({ date: v.date, fuelPrice: parseNum(v.fuelPrice), fuelPriceDate: v.fuelPriceDate || null, toll: parseNum(v.toll) })),
      }))

    if (payload.length === 0) { setError('방문일이 입력된 인원이 없습니다.'); return }

    const formData = new FormData()
    formData.append('site_id', siteId)
    formData.append('year_month', yearMonth)
    formData.append('rows', JSON.stringify(payload))
    for (const r of rows) {
      if (r.mapFile) formData.append(`receipt::${r.id}::support_trip`, r.mapFile)
    }

    startTransition(async () => {
      const res = await createSupportTrips(formData)
      if (res && 'error' in res) { setError(res.error as string) }
      else { setSuccess(true); setTimeout(() => router.push('/expenses'), 1200) }
    })
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold text-gray-800">{siteName}</h2>
          <p className="text-sm text-gray-500">
            {year}년 {parseInt(mon)}월 기술지원 기술인 출장비 — 방문일별 왕복유류비 + 통행료 + 일비 {tripDailyAllowance.toLocaleString()}원 + 식비 {tripMealAllowance.toLocaleString()}원
          </p>
        </div>
        <span className="rounded-full bg-blue-50 px-3 py-1 text-xs font-semibold text-blue-700">
          합계 {grandTotal.toLocaleString()}원
        </span>
      </div>

      {error && <div className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}
      {success && <div className="rounded-lg bg-green-50 px-4 py-3 text-sm text-green-700">저장되었습니다. 이동 중...</div>}

      <div className="space-y-3">
        {rows.map((r) => {
          const total = rowTotal(r)
          const isOpen = openRows.has(r.id)
          return (
            <div key={r.id} className="rounded-xl border border-gray-200 bg-white">
              {/* 인원 헤더 */}
              <div className="flex items-center justify-between px-4 py-3">
                <button type="button" onClick={() => toggleOpen(r.id)} className="flex items-center gap-2 text-left">
                  <span className="text-gray-400">{isOpen ? '▾' : '▸'}</span>
                  {r.userId ? (
                    <span className="text-sm font-semibold text-gray-800">{r.name}</span>
                  ) : (
                    <input type="text" value={r.name} placeholder="이름 입력" onClick={(e) => e.stopPropagation()}
                      onChange={(e) => patchRow(r.id, { name: e.target.value })}
                      className="w-24 rounded border border-gray-300 px-2 py-1 text-sm font-medium focus:border-blue-500 focus:outline-none" />
                  )}
                  <select value={r.specialty} onClick={(e) => e.stopPropagation()} onChange={(e) => patchRow(r.id, { specialty: e.target.value })}
                    className="rounded border border-gray-200 bg-gray-50 px-1.5 py-0.5 text-xs text-gray-600 focus:outline-none">
                    {SPECIALTIES.map((s) => <option key={s} value={s}>({s})</option>)}
                  </select>
                  <span className="text-xs text-gray-500">방문 {r.visits.filter((v) => v.date).length}회</span>
                </button>
                <div className="flex items-center gap-3">
                  <span className="text-sm font-semibold text-blue-700">{total > 0 ? total.toLocaleString() + '원' : '-'}</span>
                  {!r.userId && (
                    <button type="button" onClick={() => removePerson(r.id)} className="rounded p-1 text-gray-400 hover:text-red-500">✕</button>
                  )}
                </div>
              </div>

              {isOpen && (
                <div className="border-t border-gray-100 px-4 py-3 space-y-3">
                  {/* 공통 정보: 출발지·거리·유종·지도캡처 */}
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-4">
                    <div>
                      <label className="mb-0.5 block text-xs text-gray-500">출발지 (본사/자택)</label>
                      <input type="text" value={r.originAddress} onChange={(e) => patchRow(r.id, { originAddress: e.target.value })}
                        placeholder="예: 충북 청주시 흥덕구 사운로 190"
                        className="w-full rounded border border-gray-300 px-2 py-1.5 text-sm focus:border-blue-500 focus:outline-none" />
                    </div>
                    <div>
                      <label className="mb-0.5 block text-xs text-gray-500">편도거리 (km, 현장: {siteAddress || '주소 미등록'})</label>
                      <input type="text" inputMode="decimal" value={r.distanceOneway}
                        onChange={(e) => patchRow(r.id, { distanceOneway: e.target.value.replace(/[^0-9.]/g, '') })}
                        placeholder="예: 62.1"
                        className="w-full rounded border border-gray-300 px-2 py-1.5 text-sm focus:border-blue-500 focus:outline-none" />
                    </div>
                    <div>
                      <label className="mb-0.5 block text-xs text-gray-500">차종(유종)</label>
                      <select value={r.fuelType} onChange={(e) => patchRow(r.id, { fuelType: e.target.value as VehicleFuelType })}
                        className="w-full rounded border border-gray-300 px-2 py-1.5 text-sm focus:border-blue-500 focus:outline-none">
                        {Object.entries(VEHICLE_FUEL_TYPE_LABELS).map(([v, label]) => (
                          <option key={v} value={v}>{label} ({FUEL_EFFICIENCY[v as VehicleFuelType].value})</option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="mb-0.5 block text-xs text-gray-500">출장비 산출서 지도 캡처</label>
                      <input ref={(el) => { fileInputs.current[r.id] = el }} type="file" accept={ACCEPT} className="hidden"
                        onChange={(e) => {
                          const f = e.target.files?.[0] ?? null
                          if (f && f.size > MAX_SIZE) { alert('10MB 이하만 가능합니다.'); return }
                          patchRow(r.id, { mapFile: f })
                        }} />
                      <button type="button" onClick={() => fileInputs.current[r.id]?.click()}
                        className={`w-full rounded border border-dashed px-2 py-1.5 text-xs ${r.mapFile ? 'border-green-300 bg-green-50 text-green-700' : 'border-gray-300 text-gray-500 hover:border-blue-400'}`}>
                        {r.mapFile ? `📎 ${r.mapFile.name}` : '📎 캡처 첨부 (카카오맵 등)'}
                      </button>
                    </div>
                  </div>

                  {/* 방문일 목록 */}
                  {r.visits.length > 0 && (
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="text-gray-500">
                          <th className="py-1 text-left">방문일</th>
                          <th className="py-1 text-right">유가 (원/L)</th>
                          <th className="py-1 text-left pl-2">유가 기준일</th>
                          <th className="py-1 text-right">통행료(왕복)</th>
                          <th className="py-1 text-right">유류비</th>
                          <th className="py-1 text-right">일비</th>
                          <th className="py-1 text-right">식비</th>
                          <th className="py-1 text-right">계</th>
                          <th />
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-50">
                        {r.visits.map((v, idx) => {
                          const c = visitCalc(r, v)
                          return (
                            <tr key={idx}>
                              <td className="py-1 pr-2">
                                <input type="date" value={v.date} onChange={(e) => patchVisit(r.id, idx, { date: e.target.value })}
                                  className="rounded border border-gray-300 px-1.5 py-1 text-xs focus:border-blue-500 focus:outline-none" />
                              </td>
                              <td className="py-1 w-24">
                                <input type="text" inputMode="numeric" value={v.fuelPrice}
                                  onChange={(e) => { const x = e.target.value.replace(/[^0-9]/g, ''); patchVisit(r.id, idx, { fuelPrice: x ? parseInt(x).toLocaleString('ko-KR') : '' }) }}
                                  placeholder="1,650"
                                  className="w-full rounded border border-gray-300 px-1.5 py-1 text-right text-xs focus:border-blue-500 focus:outline-none" />
                              </td>
                              <td className="py-1 pl-2">
                                <input type="date" value={v.fuelPriceDate} onChange={(e) => patchVisit(r.id, idx, { fuelPriceDate: e.target.value })}
                                  className="rounded border border-gray-300 px-1.5 py-1 text-xs focus:border-blue-500 focus:outline-none" />
                              </td>
                              <td className="py-1 w-20">
                                <input type="text" inputMode="numeric" value={v.toll}
                                  onChange={(e) => { const x = e.target.value.replace(/[^0-9]/g, ''); patchVisit(r.id, idx, { toll: x ? parseInt(x).toLocaleString('ko-KR') : '' }) }}
                                  placeholder="0"
                                  className="w-full rounded border border-gray-300 px-1.5 py-1 text-right text-xs focus:border-blue-500 focus:outline-none" />
                              </td>
                              <td className="py-1 text-right text-gray-600">{c ? c.fuelCost.toLocaleString() : '-'}</td>
                              <td className="py-1 text-right text-gray-600">{tripDailyAllowance.toLocaleString()}</td>
                              <td className="py-1 text-right text-gray-600">{tripMealAllowance.toLocaleString()}</td>
                              <td className="py-1 text-right font-semibold text-blue-700">{c ? c.total.toLocaleString() : '-'}</td>
                              <td className="py-1 pl-1">
                                <button type="button" onClick={() => removeVisit(r.id, idx)} className="rounded p-0.5 text-gray-300 hover:text-red-500">✕</button>
                              </td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  )}
                  <button type="button" onClick={() => addVisit(r.id)}
                    className="rounded border border-dashed border-blue-300 px-2.5 py-1 text-xs text-blue-600 hover:bg-blue-50">
                    + 방문일 추가
                  </button>
                </div>
              )}
            </div>
          )
        })}
      </div>

      <button type="button" onClick={addPerson}
        className="flex w-full items-center justify-center gap-2 rounded-lg border-2 border-dashed border-gray-300 py-2.5 text-sm font-medium text-gray-500 hover:border-blue-400 hover:text-blue-600 transition-colors">
        + 인원 추가
      </button>

      <div className="flex gap-3 pt-2">
        <button type="button" onClick={() => router.back()}
          className="flex-1 rounded-lg border border-gray-300 bg-white py-3 text-sm font-semibold text-gray-700 hover:bg-gray-50">
          취소
        </button>
        <button type="button" onClick={handleSave} disabled={isPending || success}
          className="flex-1 rounded-lg bg-blue-600 py-3 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50">
          {isPending ? '저장 중...' : '임시저장'}
        </button>
      </div>
    </div>
  )
}
