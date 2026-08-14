'use client'

// 기술지원 기술인 출장비 입력 — 정산서 2-1 서식
// 방문일별: 왕복 유류비(거리÷연비×당일유가) + 통행료 + 일비 + 식비 (공무원 여비규정)
// 인원별 거리·유종·통행료는 공통(본사↔현장), 유가만 방문일별로 다르다.
//
// 화면은 주재비와 같은 카드 패턴: 카드 1장 = 사람 1명, 조건 바(출발지·편도·차종)는
// 인원당 한 번, 방문일은 월별 그룹 행 목록. 상태 칩으로 유가 조회 여부가 보인다.

import { useState, useTransition, useRef, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { createSupportTrips, type SupportTripRow } from '@/actions/expenses'
import { getFuelPriceForDate, getFuelPriceAverageForPeriod } from '@/actions/fuelPrice'
import { calcCommuteCost } from '@/actions/commute'
import type { AttendanceRecord, SiteStaffMember } from '@/types'
import { SPECIALTIES, VEHICLE_FUEL_TYPE_LABELS, FUEL_EFFICIENCY, type VehicleFuelType } from '@/lib/constants'
import { calcTripVisit } from '@/lib/settlement'
import { receiptFileName, receiptHref } from '@/lib/storage/receipts'

// 이미 저장한 draft 출장비 — 재진입 시 거리·유가·통행료가 복원되어야 한다.
// (복원하지 않으면 저장했던 값이 리셋되어 매번 다시 조회·입력하게 된다)
export interface SupportTripDraft {
  identity: string                 // target_user_name (명부 인원은 계정이 없어 이름이 식별자)
  originAddress: string | null
  distanceOnewayKm: number
  fuelType: string
  receiptUrls: string[]            // 산출서 지도 캡처
  visits: { date: string; fuelPrice: number; fuelPriceDate: string | null; toll: number }[]
}

interface Props {
  siteId: string
  siteName: string
  yearMonth: string
  members: SiteStaffMember[]      // 현장 기술인 명부 — 정산 인원의 단일 원천 (출근부 화면에서 등록)
  attendance: AttendanceRecord[]  // 출근부 방문일자 — 방문일 프리필 기준
  siteAddress?: string | null
  tripDailyAllowance?: number
  tripMealAllowance?: number
  /** 이미 저장된 draft 출장비 — 금액·산출 조건·첨부 복원용 */
  existingDrafts?: SupportTripDraft[]
  /** 진행 중 회차의 기성기간 — 과거 방문일 유가의 기간 평균 산출 기준 */
  periodStart?: string | null
  periodEnd?: string | null
  /** 출장비 비목의 계상 잔액 (계상 미입력이면 null) — 삭감 위험 사전 인지용 */
  categoryRemaining?: number | null
}

const ACCEPT = '.jpg,.jpeg,.png,.pdf'
const MAX_SIZE = 10 * 1024 * 1024

// basis: 유가 출처 — daily(방문일 당일 고시가) / avg(기성기간 평균) / 없음(수기)
type Visit = { date: string; fuelPrice: string; fuelPriceDate: string; toll: string; basis?: 'daily' | 'avg' }
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
  savedReceiptUrls: string[]  // 이미 저장된 지도 캡처 — 새 파일을 고르면 교체된다
  // 인원 단위 유가 — 상주 교통비(자차 왕복비 산출)와 같은 자리·같은 규칙.
  // 값이 정해지면 그 인원의 모든 방문일에 일괄 적용된다. 방문일별 개별 수정은 행에서.
  // 오피넷 무료 API가 최근 7일만 주는 지금은 사실상 전 방문일이 같은 값(기간 평균)이라
  // 인원 단위가 실제 산출 단위다. 유료 전환 후 방문일별 당일가를 되살릴 때도 여기만 바꾸면 된다.
  fuelPrice: string
  fuelPriceDate: string       // 비우면 기성기간 평균 적용
  fuelBasis?: 'daily' | 'avg'
}

let rowSeq = 0

function parseNum(v: string) { return parseInt(v.replace(/,/g, ''), 10) || 0 }

export function SupportTripForm({ siteId, siteName, yearMonth, members, attendance, siteAddress, tripDailyAllowance = 25000, tripMealAllowance = 25000, existingDrafts = [], periodStart = null, periodEnd = null, categoryRemaining = null }: Props) {
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

  // 저장된 draft를 이름 기준으로 (명부 인원은 계정이 없어 이름이 식별자)
  const draftsByName = new Map(existingDrafts.map((d) => [d.identity, d]))

  // 명부 인원 — 계정이 없으므로 이름으로 식별 (userId='')
  // 저장된 draft가 있으면 거리·유종·방문일별 유가·통행료를 복원하고,
  // 출근부에만 있는 방문일(draft에 없는 날짜)은 빈 행으로 이어붙인다.
  const [rows, setRows] = useState<PersonRow[]>(
    members.map((m, i) => {
      const d = draftsByName.get(m.name)
      const draftVisits: Visit[] = (d?.visits ?? []).map((v) => ({
        date: v.date,
        fuelPrice: v.fuelPrice > 0 ? v.fuelPrice.toLocaleString('ko-KR') : '',
        fuelPriceDate: v.fuelPriceDate ?? '',
        toll: v.toll > 0 ? v.toll.toLocaleString('ko-KR') : '',
        // 기준일이 있으면 당일가, 없이 금액만 있으면 기간 평균으로 저장했던 값
        basis: v.fuelPriceDate ? 'daily' as const : v.fuelPrice > 0 ? 'avg' as const : undefined,
      }))
      const known = new Set(draftVisits.map((v) => v.date))
      const merged = [...draftVisits, ...visitDatesOf(m.id).filter((v) => !known.has(v.date))]
        .sort((a, b) => a.date.localeCompare(b.date))
      return {
        id: `m_${m.id}`, userId: '', name: m.name,
        specialty: m.specialty && (SPECIALTIES as readonly string[]).includes(m.specialty)
          ? m.specialty
          : SPECIALTIES[i % SPECIALTIES.length],
        // 자택주소(출발지) — 출근부 화면에서 거주지 증빙으로 채운 명부 값이 자동 매핑된다
        originAddress: d?.originAddress ?? m.home_address ?? '',
        distanceOneway: d && d.distanceOnewayKm > 0 ? String(d.distanceOnewayKm) : '',
        fuelType: (d?.fuelType as VehicleFuelType) || ('gasoline' as VehicleFuelType),
        visits: merged, mapFile: null,
        savedReceiptUrls: d?.receiptUrls ?? [],
        // 인원 단위 유가는 저장된 방문일 중 첫 값에서 되살린다 (전 방문일이 같은 값인 것이 정상)
        fuelPrice: merged[0]?.fuelPrice ?? '',
        fuelPriceDate: merged[0]?.fuelPriceDate ?? '',
        fuelBasis: merged[0]?.basis,
      }
    })
  )
  const [openRows, setOpenRows] = useState<Set<string>>(
    new Set(members.map((m) => `m_${m.id}`))
  )
  const fileInputs = useRef<Record<string, HTMLInputElement | null>>({})
  // 용량 초과로 첨부되지 않은 파일명 (인원별) — 아래 onChange 주석 참고
  const [sizeWarn, setSizeWarn] = useState<Record<string, string>>({})

  // ── 저장 상태 칩 (저장됨 / 확인 필요 / 미입력) ────────────────────────────
  // 이 화면에만 상태 칩이 없어서, 소계 500,000원이 멀쩡히 떠 있는데 DB에는 한 건도
  // 저장되지 않은 상태를 화면만 보고는 알 수 없었다(실측: business_trip 행 0건).
  // 저장하지 않은 채 회차를 확정하면 그 금액이 통째로 빠진다.
  //
  // setRows 호출 지점이 많아 dirty 플래그를 곳곳에 심는 대신, 마운트 시점의 서명을
  // 기억해 두고 현재 행과 비교하는 파생값으로 판정한다(상태 복사가 없어 effect도 불필요).
  const rowSignature = (r: PersonRow) => JSON.stringify([
    r.distanceOneway, r.fuelType,
    r.visits.map((v) => [v.date, v.fuelPrice, v.fuelPriceDate, v.toll]),
  ])
  // 저장된 draft가 있는 인원 — 없으면 화면 값이 아직 DB에 없다는 뜻 (prop 파생)
  const savedNames = new Set(existingDrafts?.map((d) => d.identity) ?? [])
  // 마운트 시점 서명 — 저장 후 재진입하면 서버 draft로 다시 만들어진다.
  // ref가 아니라 state로 두는 건 렌더 중에 읽기 때문(react-hooks/refs)
  const [initialSig] = useState(() => new Map(rows.map((r) => [r.id, rowSignature(r)])))

  function rowStatus(r: PersonRow, total: number): 'saved' | 'pending' | 'empty' {
    if (total <= 0) return 'empty'
    if (!savedNames.has(r.name)) return 'pending'
    return initialSig.get(r.id) === rowSignature(r) ? 'saved' : 'pending'
  }
  const STATUS_CHIP: Record<'saved' | 'pending' | 'empty', [string, string]> = {
    saved: ['bg-green-50 text-green-700', '✓ 저장됨'],
    pending: ['bg-amber-50 text-amber-700', '확인 필요'],
    empty: ['bg-gray-100 text-gray-400', '미입력'],
  }

  // 교통비 산출 시트 — 상주 주재비의 '자차 왕복비 산출'과 같은 우측 시트.
  // 카드에는 비목(교통비·일비·식비) 합계만 보이고, 방문일·유가·통행료 상세는 여기서 다룬다.
  const [sheetRowId, setSheetRowId] = useState<string | null>(null)
  useEffect(() => {
    if (!sheetRowId) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setSheetRowId(null) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [sheetRowId])

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
    setRows((p) => [...p, { id, userId: '', name: '', specialty: '건축', originAddress: '', distanceOneway: '', fuelType: 'gasoline', visits: [], mapFile: null, savedReceiptUrls: [], fuelPrice: '', fuelPriceDate: '' }])
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

  // 방문일별 산출 (미리보기 — 서버가 동일 함수로 재계산).
  // **일비·식비는 방문 사실만으로 확정된다** — 출근부에 방문일이 전기되면 거리·유가와
  // 무관하게 계상된다(정산기준·예본 2-1). 종전에는 거리·유가가 비면 null을 돌려줘
  // 출근부가 붙어 있는데도 일비·식비가 0원으로 보이고 저장조차 되지 않았다.
  // 거리·유가가 없으면 유류비만 0이 된다(calcTripVisit이 0으로 계산).
  function visitCalc(r: PersonRow, v: Visit) {
    if (!v.date) return null
    return calcTripVisit({
      distanceOnewayKm: parseFloat(r.distanceOneway) || 0,
      fuelEfficiency: FUEL_EFFICIENCY[r.fuelType].value,
      fuelPrice: parseNum(v.fuelPrice),
      toll: parseNum(v.toll),
      dailyAllowance: tripDailyAllowance,
      mealAllowance: tripMealAllowance,
    })
  }

  // 유류비가 산출된 방문인지 — 교통비 타일·상태 칩이 "무엇이 아직 비었나"를 가릴 때 쓴다
  function isFuelPriced(r: PersonRow, v: Visit) {
    return (parseFloat(r.distanceOneway) || 0) > 0 && parseNum(v.fuelPrice) > 0
  }

  function rowTotal(r: PersonRow) {
    return r.visits.reduce((s, v) => s + (visitCalc(r, v)?.total ?? 0), 0)
  }

  // 카카오 길찾기 자동 산출 — 자택주소 ↔ 현장주소(sites.address, 주재비 시트에서 저장한 값)로
  // 편도거리를 채운다. 고속도로 우선(TIME) 기준 — 추천 경로는 무료도로면 통행료가 0으로 나온다.
  // 왕복 통행료는 통행료가 비어 있는 방문일에만 채운다(수기 입력값은 보존).
  const [routingRows, setRoutingRows] = useState<Set<string>>(new Set())
  async function autoRoute(rowId: string): Promise<boolean> {
    setError(null)
    const r = rows.find((x) => x.id === rowId)
    if (!r) return false
    if (!r.originAddress.trim()) { setError('자택주소를 먼저 입력하세요. (출근부 화면에서 거주지 증빙을 첨부하면 자동으로 채워집니다)'); return false }
    if (!siteAddress) { setError('현장주소가 등록되지 않았습니다. 대시보드 · 현장 정보에서 입력하세요.'); return false }

    const fd = new FormData()
    fd.set('home_address', r.originAddress)
    fd.set('site_address', siteAddress)
    fd.set('fuel_type', r.fuelType)
    fd.set('fuel_price', '1') // 거리·통행료만 필요 — 유가는 오피넷 조회를 쓴다
    fd.set('route_priority', 'TIME')

    setRoutingRows((p) => new Set(p).add(rowId))
    const res = await calcCommuteCost(fd)
    setRoutingRows((p) => { const n = new Set(p); n.delete(rowId); return n })
    if ('error' in res) {
      setError(res.error + ' — 지도에서 확인한 편도거리를 직접 입력해도 됩니다.')
      return false
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
    return true
  }

  // 거리·유가 한 번에 채우기 — 인원마다 산출 시트를 열어 [자동]을 두 번 누르던 수고를 없앤다.
  // 저장 전에 화면을 벗어나면 값이 사라져 이 왕복이 매번 반복됐다(테스터 실사용 피드백).
  const [autoFillRows, setAutoFillRows] = useState<Set<string>>(new Set())
  async function autoFillRow(rowId: string) {
    const r = rows.find((x) => x.id === rowId)
    if (!r) return
    setAutoFillRows((p) => new Set(p).add(rowId))
    try {
      // 거리가 이미 있으면 경로 조회는 건너뛴다 (수기 입력값·저장값 보존)
      if (!(parseFloat(r.distanceOneway) > 0)) {
        const ok = await autoRoute(rowId)
        if (!ok) return // 자택·현장주소 문제는 autoRoute가 안내한다
      }
      await autoRowFuelPrice(rowId)
    } finally {
      setAutoFillRows((p) => { const n = new Set(p); n.delete(rowId); return n })
    }
  }

  // 유가 적용 근거 안내 — 기간 평균으로 채웠을 때 표본을 보여준다 (상주 교통비와 동일)
  const [fuelBasisNotice, setFuelBasisNotice] = useState('')

  // 방문일 기준 오피넷 유가 자동조회 → 유가·유가 기준일 채움.
  // 오피넷 무료 API는 최근 7일만 주므로 과거 방문일은 당일가를 못 구한다 — 그때는
  // 상주 교통비와 같은 기성기간 평균(A안)으로 자동 대체한다. 기준일은 비워
  // 정산서에 '기간 평균'으로 표기된다. (예본 2-1도 실제로는 월 평균가를 적었다)
  function autoFuelPrice(rowId: string, idx: number, date: string, fuelType: VehicleFuelType, silent = false) {
    if (!date) return
    getFuelPriceForDate(date, fuelType).then(async (res) => {
      if (!('error' in res)) {
        patchVisit(rowId, idx, {
          fuelPrice: res.data.price.toLocaleString('ko-KR'),
          fuelPriceDate: res.data.date,
          basis: 'daily',
        })
        return
      }
      if (periodStart && periodEnd) {
        const avg = await getFuelPriceAverageForPeriod(periodStart, periodEnd, fuelType)
        if (!('error' in avg)) {
          patchVisit(rowId, idx, {
            fuelPrice: avg.data.price.toLocaleString('ko-KR'),
            fuelPriceDate: '',
            basis: 'avg',
          })
          setFuelBasisNotice(
            `기간 평균 적용: 방문일 당일 고시가는 오피넷 무료 조회 범위(최근 7일) 밖이라, 기성기간(${periodStart}~${periodEnd}) 오피넷 평균 — 고시일 ${avg.data.sampleDays}일 표본(${avg.data.from}~${avg.data.to})을 적용했습니다. 정산서에는 '기간 평균'으로 표기됩니다.`,
          )
          return
        }
      }
      if (!silent) setError(res.error)
    })
  }

  // ── 인원 단위 유가 (상주 교통비와 같은 자리·같은 규칙) ──
  // 정해진 유가는 그 인원의 모든 방문일에 일괄 적용한다.
  function applyRowFuelPrice(rowId: string, price: number, date: string, basis: 'daily' | 'avg') {
    const priceStr = price.toLocaleString('ko-KR')
    setRows((p) => p.map((r) => r.id !== rowId ? r : {
      ...r,
      fuelPrice: priceStr, fuelPriceDate: date, fuelBasis: basis,
      visits: r.visits.map((v) => ({ ...v, fuelPrice: priceStr, fuelPriceDate: date, basis })),
    }))
  }

  const [fuelRows, setFuelRows] = useState<Set<string>>(new Set())

  // 오피넷 자동조회 — 기준일을 고르면 그날 고시가, 비워두면 기성기간 평균.
  // 상주 교통비(CommuteCalcPanel)와 동일한 분기라, 유료 API로 바뀌어도 두 화면이 같이 움직인다.
  async function autoRowFuelPrice(rowId: string) {
    const r = rows.find((x) => x.id === rowId)
    if (!r) return
    setError(null)
    setFuelRows((p) => new Set(p).add(rowId))
    try {
      if (!r.fuelPriceDate && periodStart && periodEnd) {
        const res = await getFuelPriceAverageForPeriod(periodStart, periodEnd, r.fuelType)
        if ('error' in res) { setError(res.error); return }
        applyRowFuelPrice(rowId, res.data.price, '', 'avg')
        setFuelBasisNotice(
          `${r.name || '이 인원'} 유가: 기성기간(${periodStart}~${periodEnd}) 오피넷 평균 ${res.data.price.toLocaleString('ko-KR')}원 — 고시일 ${res.data.sampleDays}일 표본(${res.data.from}~${res.data.to})을 방문일 전체에 적용했습니다. 정산서에는 '기간 평균'으로 표기됩니다.`,
        )
        return
      }

      const target = r.fuelPriceDate || new Date().toISOString().slice(0, 10)
      const res = await getFuelPriceForDate(target, r.fuelType)
      if (!('error' in res)) {
        applyRowFuelPrice(rowId, res.data.price, res.data.date, 'daily')
        return
      }
      // 조회 범위(최근 7일) 밖 — 기간 평균으로 대체
      if (periodStart && periodEnd) {
        const avg = await getFuelPriceAverageForPeriod(periodStart, periodEnd, r.fuelType)
        if (!('error' in avg)) {
          applyRowFuelPrice(rowId, avg.data.price, '', 'avg')
          setFuelBasisNotice(
            `${r.name || '이 인원'} 유가: ${target} 당일 고시가는 오피넷 무료 조회 범위(최근 7일) 밖이라, 기성기간 평균 ${avg.data.price.toLocaleString('ko-KR')}원 — 고시일 ${avg.data.sampleDays}일 표본(${avg.data.from}~${avg.data.to})을 적용했습니다.`,
          )
          return
        }
      }
      setError(res.error)
    } finally {
      setFuelRows((p) => { const n = new Set(p); n.delete(rowId); return n })
    }
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

  // 방문일 상태 칩: 당일 고시가(자동) / 기간 평균 / 수기 입력 / 유가 미입력(확인 필요)
  function visitChip(v: Visit) {
    if (!v.date) return <span className="whitespace-nowrap rounded-full bg-gray-100 px-2 py-0.5 text-[11px] font-semibold text-gray-400">날짜 미지정</span>
    if (v.fuelPrice && v.fuelPriceDate) return <span className="whitespace-nowrap rounded-full bg-blue-50 px-2 py-0.5 text-[11px] font-semibold text-blue-600">자동</span>
    if (v.fuelPrice && v.basis === 'avg') return <span className="whitespace-nowrap rounded-full bg-teal-50 px-2 py-0.5 text-[11px] font-semibold text-teal-700">기간 평균</span>
    if (v.fuelPrice) return <span className="whitespace-nowrap rounded-full bg-gray-100 px-2 py-0.5 text-[11px] font-semibold text-gray-500">수기</span>
    return <span className="whitespace-nowrap rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-semibold text-amber-700">유가 확인</span>
  }

  const pendingCount = rows.filter((r) => rowStatus(r, rowTotal(r)) === 'pending').length

  // 카드도 주재비와 같은 이유로 렌더 함수 호출 방식 (JSX 태그로 쓰면 렌더마다 리마운트)
  function renderCard(r: PersonRow) {
    const total = rowTotal(r)
    const isOpen = openRows.has(r.id)
    const visitCount = r.visits.filter((v) => v.date).length
    const status = rowStatus(r, total)

    // ── 비목 요약 (교통비 / 일비 / 식비) ──
    // 정산기준·예본 2-1이 출장비를 이 세 항목으로 정의하는데, 방문일 표만으로는
    // 항목별 합계가 안 보인다 — 주재비 카드의 비목 그리드와 같은 방식으로 보여준다.
    // 일비·식비는 **방문 횟수만으로** 확정되고(출근부 연동으로 즉시 금액이 잡힌다),
    // 교통비만 거리·유가에 의존한다 — 셋을 한 조건으로 묶으면 출근부가 붙어 있는데도
    // 전부 0원으로 보인다(실제 발생한 문제).
    const dated = r.visits.filter((v) => v.date)
    const priced = dated.filter((v) => isFuelPriced(r, v))
    const pendingFuel = dated.length - priced.length
    const fuelSum = dated.reduce((s, v) => s + (visitCalc(r, v)?.fuelCost ?? 0), 0)
    const tollSum = dated.reduce((s, v) => s + parseNum(v.toll), 0)
    const transportTotal = fuelSum + tollSum
    // 유가 출처 칩 — 전부 기간 평균이면 그렇게, 전부 당일가면 자동, 섞이면 수기 포함
    const pricedBasis = priced.every((v) => v.basis === 'avg')
      ? (['bg-teal-50 text-teal-700', '기간 평균'] as const)
      : priced.every((v) => v.fuelPriceDate)
        ? (['bg-blue-50 text-blue-600', '자동'] as const)
        : (['bg-gray-100 text-gray-500', '수기 포함'] as const)
    // 거리·유가가 비어 있으면 한 번에 채운다 — 인원마다 [자동] 두 번을 반복하던 수고 제거
    const needsAutoFill = dated.length > 0 && (!(parseFloat(r.distanceOneway) > 0) || pendingFuel > 0)
    const tileChip = (cls: string, label: string) => (
      <span className={`whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-semibold ${cls}`}>{label}</span>
    )

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
          <span className={`whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-semibold ${STATUS_CHIP[status][0]}`}>
            {STATUS_CHIP[status][1]}
          </span>
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
            {/* 비목 그리드: 교통비 / 일비 / 식비 — 정산기준·예본 2-1의 출장비 구성 그대로.
                방문일·유가·통행료 상세는 교통비 산출 시트(상주의 자차 왕복비 산출과 동일 패턴)에서. */}
            <div className="grid grid-cols-3 gap-px border-t border-gray-200 bg-gray-200">
              <div className="flex min-h-[92px] flex-col gap-1 bg-white p-3.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-semibold text-gray-500">교통비 <span className="font-normal text-gray-400">(왕복유류비+통행료)</span></span>
                  {pendingFuel > 0
                    ? tileChip('bg-amber-50 text-amber-700', `유가 확인 ${pendingFuel}건`)
                    : priced.length > 0
                      ? tileChip(pricedBasis[0], pricedBasis[1])
                      : tileChip('bg-gray-100 text-gray-400', '미입력')}
                </div>
                <div className="text-[15px] font-bold text-gray-900">{transportTotal > 0 ? `${transportTotal.toLocaleString()}원` : '—'}</div>
                {priced.length > 0 && (
                  <p className="text-[11px] text-gray-400">
                    유류 {fuelSum.toLocaleString()} + 통행료 {tollSum.toLocaleString()} · {priced.length}회
                  </p>
                )}
                {/* 거리·유가를 한 번에 — 종전엔 인원마다 산출 시트를 열어 [자동]을 두 번 눌러야 했다 */}
                {needsAutoFill && (
                  <button type="button" onClick={() => autoFillRow(r.id)} disabled={autoFillRows.has(r.id)}
                    title="자택↔현장 편도거리·통행료(카카오)와 유가(오피넷)를 한 번에 채웁니다"
                    className="w-fit rounded-lg border border-green-300 bg-green-50 px-2 py-1 text-[11px] font-semibold text-green-700 hover:bg-green-100 disabled:opacity-50">
                    {autoFillRows.has(r.id) ? '채우는 중…' : `⚡ 거리·유가 자동 채우기 (${pendingFuel > 0 ? `유가 ${pendingFuel}건 ` : ''}미입력)`}
                  </button>
                )}
                <button type="button" onClick={() => setSheetRowId(r.id)}
                  className="mt-auto text-left text-xs font-semibold text-green-700 hover:underline">
                  🚗 교통비 산출 (방문일 {visitCount}회 · 거리·유가·통행료)
                </button>
              </div>
              <div className="flex min-h-[92px] flex-col gap-1 bg-white p-3.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-semibold text-gray-500">일비</span>
                  {dated.length > 0 ? tileChip('bg-blue-50 text-blue-600', '자동') : tileChip('bg-gray-100 text-gray-400', '미입력')}
                </div>
                <div className="text-[15px] font-bold text-blue-700">{dated.length > 0 ? `${(dated.length * tripDailyAllowance).toLocaleString()}원` : '—'}</div>
                <p className="text-[11px] text-gray-400">{dated.length}회 × {tripDailyAllowance.toLocaleString()}원 (출근부 방문일 기준)</p>
              </div>
              <div className="flex min-h-[92px] flex-col gap-1 bg-white p-3.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-semibold text-gray-500">식비</span>
                  {dated.length > 0 ? tileChip('bg-blue-50 text-blue-600', '자동') : tileChip('bg-gray-100 text-gray-400', '미입력')}
                </div>
                <div className="text-[15px] font-bold text-blue-700">{dated.length > 0 ? `${(dated.length * tripMealAllowance).toLocaleString()}원` : '—'}</div>
                <p className="text-[11px] text-gray-400">{dated.length}회 × {tripMealAllowance.toLocaleString()}원 (출근부 방문일 기준)</p>
              </div>
            </div>

            {/* 증빙 스트립 — 산출서 지도 캡처 (주재비 카드의 증빙 스트립과 같은 자리) */}
            <div className="flex flex-wrap items-center gap-2 border-t border-gray-100 bg-gray-50/60 px-4 py-2.5">
              <span className={`text-xs font-semibold ${r.savedReceiptUrls.length === 0 && !r.mapFile ? 'text-amber-700' : 'text-gray-500'}`}>
                증빙 (산출서 지도 캡처)
              </span>
              <input ref={(el) => { fileInputs.current[r.id] = el }} type="file" accept={ACCEPT} className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0] ?? null
                  // alert()은 미리보기 패널 등 일부 환경에서 뜨지 않아 파일이 조용히 무시된 것처럼
                  // 보인다(같은 이유로 window.confirm을 전부 걷어냈다) — 화면 안 문구로 남긴다
                  if (f && f.size > MAX_SIZE) {
                    setSizeWarn((p) => ({ ...p, [r.id]: f.name }))
                    e.target.value = ''
                    return
                  }
                  setSizeWarn((p) => { const n = { ...p }; delete n[r.id]; return n })
                  patchRow(r.id, { mapFile: f })
                }} />
              {/* 저장된 캡처 복원 — 새 파일을 고르면 저장 시 교체된다 */}
              {r.savedReceiptUrls.length > 0 && !r.mapFile && r.savedReceiptUrls.map((url) => (
                <a key={url} href={receiptHref(url)} target="_blank" rel="noreferrer" title={receiptFileName(url)}
                  className="max-w-[180px] truncate rounded-lg border border-green-200 bg-green-50 px-2 py-1 text-xs text-green-700 hover:underline">
                  📎 {receiptFileName(url)}
                </a>
              ))}
              {r.mapFile && (
                <span className="max-w-[180px] truncate rounded-lg border border-green-300 bg-green-50 px-2 py-1 text-xs text-green-700">
                  📎 {r.mapFile.name} <span className="text-[10px] text-gray-400">(저장 시 업로드)</span>
                </span>
              )}
              <button type="button" onClick={() => fileInputs.current[r.id]?.click()}
                title="카카오맵 등 경로 캡처 — 출장비 산출서에 함께 실립니다"
                className={`inline-flex items-center gap-1 whitespace-nowrap rounded-lg px-2.5 py-1 text-xs font-semibold ${
                  r.savedReceiptUrls.length === 0 && !r.mapFile
                    ? 'border border-dashed border-amber-300 bg-amber-50 text-amber-700 hover:border-amber-500 hover:bg-amber-100'
                    : 'border border-blue-200 bg-blue-50 text-blue-700 hover:border-blue-400 hover:bg-blue-100'
                }`}>
                <span aria-hidden="true">📎</span>
                {r.savedReceiptUrls.length === 0 && !r.mapFile ? '캡처 첨부 (카카오맵 등)' : '교체'}
              </button>
              {visitCount === 0 && <span className="text-xs text-gray-400">출근부에 방문일을 전기하면 자동으로 채워집니다</span>}
              {sizeWarn[r.id] && (
                <span className="flex items-center gap-1.5 rounded-lg bg-amber-50 px-2 py-1 text-xs text-amber-800">
                  ⚠ 10MB를 넘어 첨부되지 않았습니다 — {sizeWarn[r.id]}
                  <button type="button" onClick={() => setSizeWarn((p) => { const n = { ...p }; delete n[r.id]; return n })}
                    aria-label="안내 닫기" className="text-amber-400 hover:text-amber-700">✕</button>
                </span>
              )}
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
        <div className="text-right">
          <span className="rounded-full bg-blue-50 px-3 py-1 text-xs font-semibold text-blue-700">
            합계 {grandTotal.toLocaleString()}원
          </span>
          {/* 계상 잔액 — 발주청 정산(매 기성·준공)은 증빙으로 채운 만큼만 지급되므로 입력 화면에서 먼저 보인다 */}
          {categoryRemaining !== null && (
            <p className={`mt-1 text-[11px] ${categoryRemaining < 0 ? 'font-semibold text-red-500' : 'text-gray-400'}`}>
              {categoryRemaining < 0
                ? `출장비 계상 초과 ${(-categoryRemaining).toLocaleString()}원 — 총액 내 흡수 여부 확인 필요`
                : `출장비 계상 잔액 ${categoryRemaining.toLocaleString()}원`}
            </p>
          )}
        </div>
      </div>

      {error && <div className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}
      {fuelBasisNotice && (
        <div className="flex items-start gap-2 rounded-lg bg-teal-50 px-4 py-3 text-sm text-teal-800">
          <span className="min-w-0 flex-1">⛽ {fuelBasisNotice}</span>
          <button type="button" onClick={() => setFuelBasisNotice('')} aria-label="안내 닫기"
            className="text-teal-400 hover:text-teal-700">✕</button>
        </div>
      )}
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
          {/* 미저장 건수를 버튼에 실어 둔다 — 카드 칩을 못 보고 지나쳐도 여기서 한 번 더 걸린다 */}
          {isPending ? '저장 중...' : pendingCount > 0 ? `전체 임시저장 (${pendingCount}명 미저장)` : '전체 임시저장'}
        </button>
      </div>

      {/* 우측 시트 — 출장 교통비 산출 (상주 주재비의 '자차 왕복비 산출'과 같은 패턴).
          산출 조건(출발지·거리·차종·유가)은 인원당 한 번, 방문일·통행료는 표에서. */}
      {(() => {
        const sr = sheetRowId ? rows.find((x) => x.id === sheetRowId) : undefined
        if (!sr) return null
        const groups = groupVisits(sr.visits)
        const sheetTransport = sr.visits.filter((v) => v.date).reduce((s, v) => {
          const c = visitCalc(sr, v)
          return s + (c ? c.fuelCost + parseNum(v.toll) : 0)
        }, 0)
        return (
          <>
            <div className="fixed inset-0 z-40 bg-gray-900/40" onClick={() => setSheetRowId(null)} aria-hidden="true" />
            <aside role="dialog" aria-modal="true" aria-label="출장 교통비 산출"
              className="fixed inset-y-0 right-0 z-50 flex w-[min(720px,96vw)] flex-col bg-white shadow-2xl">
              <div className="flex items-start justify-between border-b border-gray-200 px-5 py-4">
                <div>
                  <h3 className="text-[15px] font-bold text-gray-900">🚗 출장 교통비 산출</h3>
                  <p className="mt-0.5 text-xs text-gray-500">
                    {sr.name || '(이름 미입력)'} ({sr.specialty}) — 왕복유류비 = 편도 × 2 × 유가 ÷ 연비 + 통행료
                  </p>
                </div>
                <button type="button" onClick={() => setSheetRowId(null)} aria-label="닫기"
                  className="rounded-lg bg-gray-100 px-2.5 py-1.5 text-sm text-gray-500 hover:bg-gray-200">✕</button>
              </div>

              <div className="flex-1 overflow-y-auto">
                {/* 산출 조건 — 상주 자차 왕복비 산출과 같은 구성 */}
                <div className="grid grid-cols-2 gap-x-4 gap-y-2 border-b border-gray-100 bg-gray-50/60 px-5 py-3 text-xs text-gray-500">
                  <label className="col-span-2 flex flex-col gap-0.5">자택주소 (출발지)
                    <input type="text" value={sr.originAddress} onChange={(e) => patchRow(sr.id, { originAddress: e.target.value })}
                      placeholder="예: 충북 단양군 단양읍 수변로 27"
                      className="w-full rounded border border-gray-300 bg-white px-2 py-1.5 text-xs text-gray-700 focus:border-blue-500 focus:outline-none" />
                  </label>
                  <label className="flex flex-col gap-0.5">편도거리 km
                    <span className="flex gap-1">
                      <input type="text" inputMode="decimal" value={sr.distanceOneway}
                        onChange={(e) => patchRow(sr.id, { distanceOneway: e.target.value.replace(/[^0-9.]/g, '') })}
                        placeholder="62.1"
                        className="w-full rounded border border-gray-300 bg-white px-2 py-1.5 text-right text-xs text-gray-700 focus:border-blue-500 focus:outline-none" />
                      <button type="button" onClick={() => autoRoute(sr.id)} disabled={routingRows.has(sr.id)}
                        title="카카오 길찾기 자동조회 — 자택↔현장 편도거리·왕복 통행료 (고속도로 우선)"
                        className="whitespace-nowrap rounded border border-green-300 bg-white px-2 py-1.5 text-xs text-green-700 hover:bg-green-50 disabled:opacity-50">
                        {routingRows.has(sr.id) ? '…' : '자동'}
                      </button>
                    </span>
                  </label>
                  <label className="flex flex-col gap-0.5">차종 (유종·연비)
                    <select value={sr.fuelType} onChange={(e) => patchRow(sr.id, { fuelType: e.target.value as VehicleFuelType })}
                      className="w-full rounded border border-gray-300 bg-white px-2 py-1.5 text-xs text-gray-700 focus:border-blue-500 focus:outline-none">
                      {Object.entries(VEHICLE_FUEL_TYPE_LABELS).map(([v, label]) => (
                        <option key={v} value={v}>{label} ({FUEL_EFFICIENCY[v as VehicleFuelType].value}km/L)</option>
                      ))}
                    </select>
                  </label>
                  {/* 유가 — 상주와 같은 규칙: 기준일을 고르면 그날 고시가, 비우면 기성기간 평균.
                      정한 값은 방문일 전체에 적용, 방문일별 개별 수정은 아래 표에서. */}
                  <label className="flex flex-col gap-0.5">유가 (원/L · 오피넷) — 방문일 전체 적용
                    <span className="flex gap-1">
                      <input type="text" inputMode="numeric" value={sr.fuelPrice}
                        onChange={(e) => {
                          const x = e.target.value.replace(/[^0-9]/g, '')
                          const n = x ? parseInt(x, 10) : 0
                          if (n > 0) applyRowFuelPrice(sr.id, n, sr.fuelPriceDate, sr.fuelPriceDate ? 'daily' : 'avg')
                          else patchRow(sr.id, { fuelPrice: '', fuelBasis: undefined })
                        }}
                        placeholder="1,650"
                        className="w-full rounded border border-gray-300 bg-white px-2 py-1.5 text-right text-xs text-gray-700 focus:border-blue-500 focus:outline-none" />
                      <button type="button" onClick={() => autoRowFuelPrice(sr.id)} disabled={fuelRows.has(sr.id)}
                        title="오피넷 유가 자동조회 — 기준일을 고르면 해당일 고시가, 비워두면 기성기간 평균"
                        className="whitespace-nowrap rounded border border-green-300 bg-white px-2 py-1.5 text-xs text-green-700 hover:bg-green-50 disabled:opacity-50">
                        {fuelRows.has(sr.id) ? '…' : '자동'}
                      </button>
                    </span>
                  </label>
                  <label className="flex flex-col gap-0.5">
                    유가 기준일 {periodStart && periodEnd ? '(비우면 기간 평균)' : '(opinet.co.kr 고시)'}
                    <input type="date" value={sr.fuelPriceDate}
                      onChange={(e) => {
                        const d = e.target.value
                        setRows((p) => p.map((x) => x.id !== sr.id ? x : {
                          ...x, fuelPriceDate: d,
                          visits: x.visits.map((v) => ({ ...v, fuelPriceDate: d, basis: d ? 'daily' : v.fuelPrice ? 'avg' : undefined })),
                        }))
                      }}
                      className="w-full rounded border border-gray-300 bg-white px-2 py-1.5 text-xs text-gray-700 focus:border-blue-500 focus:outline-none" />
                  </label>
                  <span className="col-span-2 text-[11px] text-gray-400">
                    현장: {siteAddress || '주소 미등록 — 대시보드 · 현장 정보에서 입력'} · 자택↔현장 왕복 기준
                  </span>
                </div>

                {/* 방문일 표 — 교통비만 (일비·식비는 카드 비목 타일에서 방문 횟수로 자동) */}
                {sr.visits.length > 0 && (
                  <div className="overflow-x-auto">
                    <div className="min-w-[700px]">
                      <div className="grid grid-cols-[150px_150px_112px_80px_1fr_80px_24px] items-center gap-2 px-5 pt-2.5 pb-1 text-[10.5px] font-semibold text-gray-400">
                        <span>방문일</span>
                        <span className="text-right">유가 (원/L)</span>
                        <span>유가 기준일</span>
                        <span className="text-right">통행료(왕복)</span>
                        <span className="text-right">왕복유류비</span>
                        <span className="text-right">교통비</span>
                        <span />
                      </div>
                      {groups.map((g) => (
                        <div key={g.label}>
                          <div className="px-5 pt-1.5 pb-0.5 text-[11px] font-bold tracking-wide text-gray-400">{g.label}</div>
                          {g.items.map(({ v, idx }) => {
                            const c = visitCalc(sr, v)
                            return (
                              <div key={idx}
                                className="grid grid-cols-[150px_150px_112px_80px_1fr_80px_24px] items-center gap-2 border-t border-gray-50 px-5 py-1.5 text-xs hover:bg-gray-50/60">
                                <span className="flex items-center gap-1.5">
                                  <input type="date" value={v.date}
                                    onChange={(e) => {
                                      const d = e.target.value
                                      patchVisit(sr.id, idx, { date: d })
                                      // 방문일 선택 시 해당일 오피넷 유가 자동 채움 (실패는 조용히 — 기간 평균으로 대체됨)
                                      autoFuelPrice(sr.id, idx, d, sr.fuelType, true)
                                    }}
                                    className="rounded border border-gray-300 px-1.5 py-1 text-xs focus:border-blue-500 focus:outline-none" />
                                  {visitChip(v)}
                                </span>
                                <span className="flex justify-end gap-0.5">
                                  <input type="text" inputMode="numeric" value={v.fuelPrice}
                                    onChange={(e) => { const x = e.target.value.replace(/[^0-9]/g, ''); patchVisit(sr.id, idx, { fuelPrice: x ? parseInt(x).toLocaleString('ko-KR') : '', fuelPriceDate: '', basis: undefined }) }}
                                    placeholder="1,650"
                                    className="w-20 rounded border border-gray-300 px-1.5 py-1 text-right text-xs focus:border-blue-500 focus:outline-none" />
                                  <button type="button" onClick={() => autoFuelPrice(sr.id, idx, v.date, sr.fuelType)}
                                    title="방문일 당일 오피넷 고시가 — 조회 범위(최근 7일) 밖이면 기성기간 평균을 적용"
                                    className="whitespace-nowrap rounded border border-green-300 bg-white px-1.5 py-1 text-xs text-green-700 hover:bg-green-50">
                                    자동
                                  </button>
                                </span>
                                <input type="date" value={v.fuelPriceDate} onChange={(e) => patchVisit(sr.id, idx, { fuelPriceDate: e.target.value })}
                                  className="rounded border border-gray-300 px-1.5 py-1 text-xs focus:border-blue-500 focus:outline-none" />
                                <input type="text" inputMode="numeric" value={v.toll}
                                  onChange={(e) => { const x = e.target.value.replace(/[^0-9]/g, ''); patchVisit(sr.id, idx, { toll: x ? parseInt(x).toLocaleString('ko-KR') : '' }) }}
                                  placeholder="0"
                                  className="w-full rounded border border-gray-300 px-1.5 py-1 text-right text-xs focus:border-blue-500 focus:outline-none" />
                                {/* 예본 2-1 열 구성(거리·연비·단가→산출금액)이 보이도록 산식을 함께 표기 */}
                                <span className="text-right text-gray-600">
                                  {c ? c.fuelCost.toLocaleString() : '—'}
                                  {c && (
                                    <span className="block whitespace-nowrap text-[10px] text-gray-400">
                                      {c.distanceRoundtripKm}km×{parseNum(v.fuelPrice).toLocaleString()}÷{FUEL_EFFICIENCY[sr.fuelType].value}
                                    </span>
                                  )}
                                </span>
                                <span className="text-right font-semibold text-green-700">
                                  {c ? (c.fuelCost + parseNum(v.toll)).toLocaleString() : '—'}
                                </span>
                                <button type="button" onClick={() => removeVisit(sr.id, idx)} aria-label="방문일 삭제"
                                  className="rounded p-0.5 text-gray-300 hover:text-red-500">✕</button>
                              </div>
                            )
                          })}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                <div className="flex flex-wrap items-center gap-2 border-t border-gray-100 px-5 py-2.5">
                  <button type="button" onClick={() => addVisit(sr.id)}
                    className="rounded-lg border border-dashed border-gray-300 px-2.5 py-1 text-xs font-semibold text-gray-500 hover:border-blue-400 hover:text-blue-600">
                    + 방문일 추가
                  </button>
                  {sr.visits.some((v) => v.date && !v.fuelPrice) && (
                    <span className="text-xs text-amber-700">⚠ 유가가 비어 있습니다 — 위 <b>유가 [자동]</b>을 누르면 방문일 전체에 적용됩니다.</span>
                  )}
                  {sr.visits.filter((v) => v.date).length === 0 && (
                    <span className="text-xs text-gray-400">출근부에 방문일을 전기하면 자동으로 채워집니다</span>
                  )}
                </div>
              </div>

              <div className="border-t border-gray-200 px-5 py-3.5">
                {/* 닫기 = 이 시트의 마무리 — 입력값은 카드에 즉시 반영되어 있다 (별도 적용 버튼 없음) */}
                <button type="button" onClick={() => setSheetRowId(null)}
                  className="w-full rounded-lg bg-blue-600 py-2.5 text-sm font-bold text-white hover:bg-blue-700">
                  교통비 {sheetTransport > 0 ? `${sheetTransport.toLocaleString()}원 ` : ''}확인 — 카드로 돌아가기
                </button>
                <p className="mt-1 text-center text-[11px] text-gray-400">입력값은 카드에 즉시 반영됩니다 · 확정은 화면 맨 아래 [전체 임시저장]</p>
              </div>
            </aside>
          </>
        )
      })()}
    </div>
  )
}
