'use client'

// 기술지원 기술인 출장비 입력 — 정산서 2-1 서식
// 방문일별: 왕복 유류비(거리÷연비×당일유가) + 통행료 + 일비 + 식비 (공무원 여비규정)
// 인원별 거리·유종·통행료는 공통(본사↔현장), 유가만 방문일별로 다르다.
//
// 화면은 주재비와 같은 카드 패턴: 카드 1장 = 사람 1명, 조건 바(출발지·편도·차종)는
// 인원당 한 번, 방문일은 월별 그룹 행 목록. 상태 칩으로 유가 조회 여부가 보인다.

import { useState, useTransition, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { createSupportTrips, type SupportTripRow } from '@/actions/expenses'
import { getFuelPriceForDate } from '@/actions/fuelPrice'
import { calcCommuteCost } from '@/actions/commute'
import type { AttendanceRecord, SiteStaffMember } from '@/types'
import { SPECIALTIES, VEHICLE_FUEL_TYPE_LABELS, FUEL_EFFICIENCY, type VehicleFuelType } from '@/lib/constants'
import { calcTripVisit } from '@/lib/settlement'

interface Props {
  siteId: string
  siteName: string
  yearMonth: string
  members: SiteStaffMember[]      // 현장 기술인 명부 — 정산 인원의 단일 원천 (출근부 화면에서 등록)
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

export function SupportTripForm({ siteId, siteName, yearMonth, members, attendance, siteAddress, tripDailyAllowance = 25000, tripMealAllowance = 25000 }: Props) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)

  // 출근부 방문일자 → 방문일 프리필 (유가·통행료는 입력)
  const visitDatesOf = (memberId: string): Visit[] => {
    const rec = attendance.find((a) => a.member_id === memberId)
    return (rec?.visit_dates ?? []).map((date) => ({ date, fuelPrice: '', fuelPriceDate: '', toll: '' }))
  }
  // 출근부에서 방문일이 넘어온 인원 — 카드에 "출근부 연동" 칩 표시
  const attendanceLinked = new Set(
    members.filter((m) => (attendance.find((a) => a.member_id === m.id)?.visit_dates?.length ?? 0) > 0).map((m) => `m_${m.id}`),
  )

  // 명부 인원 — 계정이 없으므로 이름으로 식별 (userId='')
  const [rows, setRows] = useState<PersonRow[]>(
    members.map((m, i) => ({
      id: `m_${m.id}`, userId: '', name: m.name,
      specialty: m.specialty && (SPECIALTIES as readonly string[]).includes(m.specialty)
        ? m.specialty
        : SPECIALTIES[i % SPECIALTIES.length],
      originAddress: '', distanceOneway: '', fuelType: 'gasoline' as VehicleFuelType,
      visits: visitDatesOf(m.id), mapFile: null,
    }))
  )
  const [openRows, setOpenRows] = useState<Set<string>>(
    new Set(members.map((m) => `m_${m.id}`))
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

  // 카카오 길찾기 자동 산출 — 자택주소 ↔ 현장주소(sites.address, 주재비 시트에서 저장한 값)로
  // 편도거리를 채운다. 고속도로 우선(TIME) 기준 — 추천 경로는 무료도로면 통행료가 0으로 나온다.
  // 왕복 통행료는 통행료가 비어 있는 방문일에만 채운다(수기 입력값은 보존).
  const [routingRows, setRoutingRows] = useState<Set<string>>(new Set())
  function autoRoute(rowId: string) {
    setError(null)
    const r = rows.find((x) => x.id === rowId)
    if (!r) return
    if (!r.originAddress.trim()) { setError('자택주소를 먼저 입력하세요.'); return }
    if (!siteAddress) { setError('현장주소가 등록되지 않았습니다. 상주기술인 주재비 → 자차 왕복비 산출에서 현장주소를 저장하세요.'); return }

    const fd = new FormData()
    fd.set('home_address', r.originAddress)
    fd.set('site_address', siteAddress)
    fd.set('fuel_type', r.fuelType)
    fd.set('fuel_price', '1') // 거리·통행료만 필요 — 유가는 방문일별 오피넷 조회를 쓴다
    fd.set('route_priority', 'TIME')

    setRoutingRows((p) => new Set(p).add(rowId))
    calcCommuteCost(fd).then((res) => {
      setRoutingRows((p) => { const n = new Set(p); n.delete(rowId); return n })
      if ('error' in res) {
        setError(res.error + ' — 지도에서 확인한 편도거리를 직접 입력해도 됩니다.')
        return
      }
      const tollStr = res.data.tollRoundTrip > 0 ? res.data.tollRoundTrip.toLocaleString('ko-KR') : ''
      setRows((p) => p.map((row) => {
        if (row.id !== rowId) return row
        return {
          ...row,
          distanceOneway: String(res.data.distanceOneWayKm),
          visits: tollStr ? row.visits.map((v) => (v.toll ? v : { ...v, toll: tollStr })) : row.visits,
        }
      }))
    })
  }

  // 방문일 기준 오피넷 유가 자동조회 → 유가·유가 기준일 채움 (예본: 운행일자 고시 유가 적용)
  function autoFuelPrice(rowId: string, idx: number, date: string, fuelType: VehicleFuelType, silent = false) {
    if (!date) return
    getFuelPriceForDate(date, fuelType).then((res) => {
      if ('error' in res) {
        if (!silent) setError(res.error)
        return
      }
      patchVisit(rowId, idx, {
        fuelPrice: res.data.price.toLocaleString('ko-KR'),
        fuelPriceDate: res.data.date,
      })
    })
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

  // 방문일을 월별로 묶는다 — 5개월 기성기간에서도 목록을 훑기 쉽게.
  // 날짜 미지정 행은 맨 뒤 그룹으로.
  function groupVisits(visits: Visit[]): { label: string; items: { v: Visit; idx: number }[] }[] {
    const groups = new Map<string, { v: Visit; idx: number }[]>()
    visits.forEach((v, idx) => {
      const key = v.date ? v.date.slice(0, 7) : '날짜 미지정'
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key)!.push({ v, idx })
    })
    return [...groups.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([label, items]) => ({ label, items }))
  }

  // 방문일 상태 칩: 오피넷 조회됨(자동) / 수기 입력 / 유가 미입력(확인 필요)
  function visitChip(v: Visit) {
    if (!v.date) return <span className="whitespace-nowrap rounded-full bg-gray-100 px-2 py-0.5 text-[11px] font-semibold text-gray-400">날짜 미지정</span>
    if (v.fuelPrice && v.fuelPriceDate) return <span className="whitespace-nowrap rounded-full bg-blue-50 px-2 py-0.5 text-[11px] font-semibold text-blue-600">자동</span>
    if (v.fuelPrice) return <span className="whitespace-nowrap rounded-full bg-gray-100 px-2 py-0.5 text-[11px] font-semibold text-gray-500">수기</span>
    return <span className="whitespace-nowrap rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-semibold text-amber-700">유가 확인</span>
  }

  // 카드도 주재비와 같은 이유로 렌더 함수 호출 방식 (JSX 태그로 쓰면 렌더마다 리마운트)
  function renderCard(r: PersonRow) {
    const total = rowTotal(r)
    const isOpen = openRows.has(r.id)
    const visitCount = r.visits.filter((v) => v.date).length
    const groups = groupVisits(r.visits)

    return (
      <article key={r.id} className="overflow-hidden rounded-xl border border-gray-200 border-l-4 border-l-teal-500 bg-white shadow-sm">
        {/* 요약 행 — 클릭하면 접기/펼치기 (입력 요소 클릭은 제외) */}
        <div
          className="flex cursor-pointer select-none flex-wrap items-center gap-x-2.5 gap-y-1.5 px-4 py-3 hover:bg-gray-50/70"
          onClick={(e) => { if ((e.target as HTMLElement).closest('input,select,button,a,label')) return; toggleOpen(r.id) }}
        >
          {r.userId ? (
            <span className="text-[15px] font-bold text-gray-900">{r.name}</span>
          ) : (
            <input type="text" value={r.name} placeholder="이름 입력"
              onChange={(e) => patchRow(r.id, { name: e.target.value })}
              className="w-28 rounded border border-transparent bg-transparent px-1.5 py-1 text-[15px] font-bold text-gray-900 hover:border-gray-300 focus:border-blue-500 focus:bg-white focus:outline-none" />
          )}
          <select value={r.specialty} onChange={(e) => patchRow(r.id, { specialty: e.target.value })}
            className="rounded border border-gray-200 bg-gray-50 px-1.5 py-0.5 text-xs text-gray-600 focus:border-blue-400 focus:outline-none">
            {SPECIALTIES.map((s) => <option key={s} value={s}>({s})</option>)}
          </select>
          <span className="whitespace-nowrap rounded-full bg-teal-50 px-2 py-0.5 text-[11px] font-semibold text-teal-700">출장 {visitCount}회</span>
          {attendanceLinked.has(r.id) && (
            <span className="whitespace-nowrap rounded-full bg-green-50 px-2 py-0.5 text-[11px] font-semibold text-green-700">출근부 연동</span>
          )}
          <div className="ml-auto flex items-center gap-2.5">
            <div className="text-right">
              <div className="text-[15px] font-bold text-gray-900">{total > 0 ? `${total.toLocaleString()}원` : '—'}</div>
              <div className="text-[10px] text-gray-400">소계</div>
            </div>
            <button type="button" onClick={() => toggleOpen(r.id)} aria-expanded={isOpen} aria-label="상세 접기/펼치기"
              className={`rounded p-1 text-gray-400 transition-transform hover:bg-gray-100 ${isOpen ? 'rotate-180' : ''}`}>▾</button>
            <button type="button" onClick={() => removePerson(r.id)}
              title={r.id.startsWith('extra_') ? '행 삭제' : '이번 달 입력에서 제외'}
              className="rounded p-1 text-gray-300 hover:bg-red-50 hover:text-red-500">✕</button>
          </div>
        </div>

        {isOpen && (
          <>
            {/* 조건 바 — 출발지·편도거리·차종·지도 캡처는 인원당 한 번 */}
            <div className="flex flex-wrap items-end gap-x-5 gap-y-2 border-t border-gray-100 bg-gray-50/60 px-4 py-2.5 text-xs text-gray-500">
              <label className="flex flex-col gap-0.5">자택주소 (출발지)
                <input type="text" value={r.originAddress} onChange={(e) => patchRow(r.id, { originAddress: e.target.value })}
                  placeholder="예: 충북 단양군 단양읍 수변로 27"
                  className="w-64 rounded border border-gray-300 bg-white px-2 py-1.5 text-xs text-gray-700 focus:border-blue-500 focus:outline-none" />
              </label>
              <label className="flex flex-col gap-0.5">편도거리 km
                <span className="flex gap-1">
                  <input type="text" inputMode="decimal" value={r.distanceOneway}
                    onChange={(e) => patchRow(r.id, { distanceOneway: e.target.value.replace(/[^0-9.]/g, '') })}
                    placeholder="62.1"
                    className="w-20 rounded border border-gray-300 bg-white px-2 py-1.5 text-right text-xs text-gray-700 focus:border-blue-500 focus:outline-none" />
                  <button type="button" onClick={() => autoRoute(r.id)} disabled={routingRows.has(r.id)}
                    title="카카오 길찾기 자동조회 — 자택↔현장 편도거리·왕복 통행료 (고속도로 우선)"
                    className="whitespace-nowrap rounded border border-green-300 bg-white px-2 py-1.5 text-xs text-green-700 hover:bg-green-50 disabled:opacity-50">
                    {routingRows.has(r.id) ? '…' : '자동'}
                  </button>
                </span>
              </label>
              <label className="flex flex-col gap-0.5">차종 (유종·연비)
                <select value={r.fuelType} onChange={(e) => patchRow(r.id, { fuelType: e.target.value as VehicleFuelType })}
                  className="rounded border border-gray-300 bg-white px-2 py-1.5 text-xs text-gray-700 focus:border-blue-500 focus:outline-none">
                  {Object.entries(VEHICLE_FUEL_TYPE_LABELS).map(([v, label]) => (
                    <option key={v} value={v}>{label} ({FUEL_EFFICIENCY[v as VehicleFuelType].value}km/L)</option>
                  ))}
                </select>
              </label>
              <div className="flex flex-col gap-0.5">
                <span>산출서 지도 캡처</span>
                <input ref={(el) => { fileInputs.current[r.id] = el }} type="file" accept={ACCEPT} className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0] ?? null
                    if (f && f.size > MAX_SIZE) { alert('10MB 이하만 가능합니다.'); return }
                    patchRow(r.id, { mapFile: f })
                  }} />
                <button type="button" onClick={() => fileInputs.current[r.id]?.click()}
                  className={`rounded border border-dashed px-2.5 py-1.5 text-xs ${r.mapFile ? 'border-green-300 bg-green-50 text-green-700' : 'border-gray-300 text-gray-500 hover:border-blue-400 hover:text-blue-600'}`}>
                  {r.mapFile ? `📎 ${r.mapFile.name}` : '📎 캡처 첨부 (카카오맵 등)'}
                </button>
              </div>
              <span className="pb-1.5 text-[11px] text-gray-400">현장: {siteAddress || '주소 미등록 — 주재비 화면의 자차 산출에서 저장'} · 자택↔현장 왕복 기준 · 왕복유류비 = 편도 × 2 ÷ 연비 × 당일 유가</span>
            </div>

            {/* 방문일 목록 — 월별 그룹 */}
            {r.visits.length > 0 && (
              <div className="overflow-x-auto border-t border-gray-100">
                <div className="min-w-[860px]">
                  <div className="grid grid-cols-[190px_170px_120px_90px_1fr_1fr_100px_30px] items-center gap-2 px-4 pt-2 pb-1 text-[10.5px] font-semibold text-gray-400">
                    <span>방문일</span>
                    <span className="text-right">유가 (원/L · 오피넷)</span>
                    <span>유가 기준일</span>
                    <span className="text-right">통행료(왕복)</span>
                    <span className="text-right">왕복유류비</span>
                    <span className="text-right">일비+식비</span>
                    <span className="text-right">소계</span>
                    <span />
                  </div>
                  {groups.map((g) => (
                    <div key={g.label}>
                      <div className="px-4 pt-1.5 pb-0.5 text-[11px] font-bold tracking-wide text-gray-400">{g.label}</div>
                      {g.items.map(({ v, idx }) => {
                        const c = visitCalc(r, v)
                        return (
                          <div key={idx}
                            className="grid grid-cols-[190px_170px_120px_90px_1fr_1fr_100px_30px] items-center gap-2 border-t border-gray-50 px-4 py-1.5 text-xs hover:bg-gray-50/60">
                            <span className="flex items-center gap-1.5">
                              <input type="date" value={v.date}
                                onChange={(e) => {
                                  const d = e.target.value
                                  patchVisit(r.id, idx, { date: d })
                                  // 방문일 선택 시 해당일 오피넷 유가 자동 채움 (실패는 조용히 — 수기 입력 가능)
                                  autoFuelPrice(r.id, idx, d, r.fuelType, true)
                                }}
                                className="rounded border border-gray-300 px-1.5 py-1 text-xs focus:border-blue-500 focus:outline-none" />
                              {visitChip(v)}
                            </span>
                            <span className="flex justify-end gap-0.5">
                              <input type="text" inputMode="numeric" value={v.fuelPrice}
                                onChange={(e) => { const x = e.target.value.replace(/[^0-9]/g, ''); patchVisit(r.id, idx, { fuelPrice: x ? parseInt(x).toLocaleString('ko-KR') : '', fuelPriceDate: '' }) }}
                                placeholder="1,650"
                                className="w-20 rounded border border-gray-300 px-1.5 py-1 text-right text-xs focus:border-blue-500 focus:outline-none" />
                              <button type="button" onClick={() => autoFuelPrice(r.id, idx, v.date, r.fuelType)}
                                title="방문일 기준 오피넷 유가 자동조회"
                                className="whitespace-nowrap rounded border border-green-300 bg-white px-1.5 py-1 text-xs text-green-700 hover:bg-green-50">
                                자동
                              </button>
                            </span>
                            <input type="date" value={v.fuelPriceDate} onChange={(e) => patchVisit(r.id, idx, { fuelPriceDate: e.target.value })}
                              className="rounded border border-gray-300 px-1.5 py-1 text-xs focus:border-blue-500 focus:outline-none" />
                            <input type="text" inputMode="numeric" value={v.toll}
                              onChange={(e) => { const x = e.target.value.replace(/[^0-9]/g, ''); patchVisit(r.id, idx, { toll: x ? parseInt(x).toLocaleString('ko-KR') : '' }) }}
                              placeholder="0"
                              className="w-full rounded border border-gray-300 px-1.5 py-1 text-right text-xs focus:border-blue-500 focus:outline-none" />
                            <span className="text-right text-gray-600">{c ? c.fuelCost.toLocaleString() : '—'}</span>
                            <span className="text-right text-gray-600">
                              {(tripDailyAllowance + tripMealAllowance).toLocaleString()}
                              <span className="block text-[10px] text-gray-400">{tripDailyAllowance.toLocaleString()} + {tripMealAllowance.toLocaleString()}</span>
                            </span>
                            <span className="text-right font-semibold text-blue-700">{c ? c.total.toLocaleString() : '—'}</span>
                            <button type="button" onClick={() => removeVisit(r.id, idx)} aria-label="방문일 삭제"
                              className="rounded p-0.5 text-gray-300 hover:text-red-500">✕</button>
                          </div>
                        )
                      })}
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="flex flex-wrap items-center gap-2 border-t border-gray-100 bg-gray-50/60 px-4 py-2.5">
              <button type="button" onClick={() => addVisit(r.id)}
                className="rounded-lg border border-dashed border-gray-300 px-2.5 py-1 text-xs font-semibold text-gray-500 hover:border-blue-400 hover:text-blue-600">
                + 방문일 추가
              </button>
              {visitCount === 0 && <span className="text-xs text-gray-400">출근부에 방문일을 전기하면 자동으로 채워집니다</span>}
            </div>
          </>
        )}
      </article>
    )
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
        {rows.map((r) => renderCard(r))}
      </div>

      <button type="button" onClick={addPerson}
        className="flex w-full items-center justify-center gap-2 rounded-lg border-2 border-dashed border-gray-300 py-2.5 text-sm font-medium text-gray-500 transition-colors hover:border-blue-400 hover:text-blue-600">
        + 인원 추가
      </button>

      <div className="flex gap-3 pt-1">
        <button type="button" onClick={() => router.back()}
          className="flex-1 rounded-lg border border-gray-300 bg-white py-3 text-sm font-semibold text-gray-700 hover:bg-gray-50">
          취소
        </button>
        <button type="button" onClick={handleSave} disabled={isPending || success}
          className="flex-1 rounded-lg bg-blue-600 py-3 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50">
          {isPending ? '저장 중...' : '전체 임시저장'}
        </button>
      </div>
    </div>
  )
}
