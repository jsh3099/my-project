'use client'

import { Fragment, useEffect, useRef, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/Button'
import { upsertAttendance, addSiteStaffMember, deactivateSiteStaffMember, updateSiteStaffResidence, parseAttendanceSheet, uploadResidenceDoc, removeResidenceDoc, updateStaffHomeAddress, reparseResidenceAddress } from '@/actions/attendance'
import {
  STAFF_TYPE_LABELS,
  SPECIALTIES,
  RESIDENCE_TYPES,
  RESIDENCE_TYPE_LABELS,
  RESIDENCE_TYPE_ICONS,
  type StaffType,
  type ResidenceType,
} from '@/lib/constants'
import type { AttendanceRecord, SiteStaffMember } from '@/types'

interface Props {
  siteId: string
  roundId: string
  periodStart: string // YYYY-MM-DD
  periodEnd: string
  months: string[] // 회차 기간의 연월 목록 ("YYYY-MM")
  staffType: StaffType
  members: SiteStaffMember[] // 기술인 명부 인원 — 정산 인원의 단일 원천 (로그인 계정과 무관)
  records: AttendanceRecord[] // 회차 기간 내 월별 레코드
  sheetFileUrls: string[] // 회차 기간 내 첨부 (통합)
}

// 인원 행 (key=m_{memberId})
type PersonRow = {
  key: string
  name: string
  specialty: string | null
  memberId: string
  residenceType: ResidenceType
  residenceDocUrls: string[] // 거주지 증빙 (재직증명서 등) — 교통비 자택주소 근거
  homeAddress: string | null // 자택주소 — 교통비·출장비 산출 출발지로 자동 매핑
}

// 입력값의 출처 — 상태 칩을 가른다
// saved: 서버 저장값과 일치 / parsed: PDF 인식값(미저장) / manual: 수기 입력(미저장) / empty: 미입력
type ValueSource = 'saved' | 'parsed' | 'manual' | 'empty'

// 출근부 구분 섹션 — 기성회차 단위. 목업(attendance-redesign-mockup.html) 기준 개편:
// 구분 카드(상주=보라·주재비 연동 / 기술지원=청록·출장비 연동), 첨부 스트립,
// 자동 인식 배너, 인원 행 상태 칩, 월별 인식 근거는 우측 시트. 저장 모델은 그대로
// (첨부 1부 + 상주 합계는 회차 시작 월 레코드, 방문일은 월별 레코드).
export function AttendanceSheetSection({
  siteId, roundId, periodStart, periodEnd, months, staffType, members, records, sheetFileUrls,
}: Props) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [isMemberPending, startMemberTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)
  // 기존 첨부 중 유지할 것 (X 클릭 시 제외 → 저장 시 삭제 처리)
  const [keptUrls, setKeptUrls] = useState<string[]>(sheetFileUrls)
  // 저장 후 router.refresh()로 서버 첨부 목록이 갱신되면 화면도 따라간다
  // (새로 업로드된 파일이 기존 첨부 칩으로 나타난다)
  useEffect(() => { setKeptUrls(sheetFileUrls) }, [sheetFileUrls])
  // 새로 선택한 파일 이름 (input.files에 담겨 있다가 저장 시 업로드)
  const [pickedNames, setPickedNames] = useState<string[]>([])
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  // 인원 추가 입력
  const [newName, setNewName] = useState('')
  const [newSpecialty, setNewSpecialty] = useState('')

  const isSupport = staffType === 'support'

  const persons: PersonRow[] = members.map((m) => ({
    key: `m_${m.id}`, name: m.name, specialty: m.specialty, memberId: m.id,
    residenceType: m.residence_type ?? RESIDENCE_TYPES.LODGING,
    residenceDocUrls: m.residence_doc_urls ?? [],
    homeAddress: m.home_address ?? null,
  }))

  // 거주지 증빙 첨부 — 선택 즉시 업로드·저장한다 (출근부 저장 폼과 독립, 사람에 딸린 서류)
  const docInputs = useRef<Record<string, HTMLInputElement | null>>({})
  function handleDocSelected(p: PersonRow, e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []).filter((f) => f.size > 0)
    e.target.value = ''
    if (files.length === 0) return
    const fd = new FormData()
    for (const f of files) fd.append('doc_files', f)
    startMemberTransition(async () => {
      const res = await uploadResidenceDoc(p.memberId, fd)
      if (res && 'error' in res) {
        setError(res.error as string)
        return
      }
      // 인식 결과 안내 — 자택주소가 채워졌으면 확인을 유도한다 (인식값은 제안)
      const addr = (res as { parsedAddress?: string }).parsedAddress
      setAddrNotice({
        key: p.key,
        text: addr
          ? `${p.name} 자택주소를 증빙에서 인식했습니다: ${addr} — 교통비 산출에 자동 적용됩니다. 다르면 수정하세요.`
          : `${p.name} 증빙은 첨부됐지만 자택주소를 읽지 못했습니다 (스캔 이미지이거나 형식이 다름). 주소를 직접 입력하세요.`,
        ok: !!addr,
      })
      router.refresh()
    })
  }

  // 자택주소 인식 결과 안내 (인원별 1건)
  const [addrNotice, setAddrNotice] = useState<{ key: string; text: string; ok: boolean } | null>(null)
  // 자택주소 직접 입력 — 열려 있는 인원 key와 편집 중 값
  const [addrEditKey, setAddrEditKey] = useState<string | null>(null)
  const [addrDraft, setAddrDraft] = useState('')
  // 첨부된 증빙에서 주소 재인식 — 업로드 시점에 인식 기능이 없었거나 실패한 경우
  function handleAddrReparse(p: PersonRow) {
    setError(null)
    startMemberTransition(async () => {
      const res = await reparseResidenceAddress(p.memberId)
      if (res && 'error' in res) {
        setAddrNotice({ key: p.key, text: `${p.name}: ${res.error as string}`, ok: false })
        return
      }
      const addr = (res as { parsedAddress?: string }).parsedAddress
      setAddrNotice({
        key: p.key,
        text: `${p.name} 자택주소를 증빙에서 인식했습니다: ${addr} — 교통비 산출에 자동 적용됩니다. 다르면 수정하세요.`,
        ok: true,
      })
      router.refresh()
    })
  }

  function handleAddrSave(p: PersonRow) {
    setAddrNotice(null)
    startMemberTransition(async () => {
      const res = await updateStaffHomeAddress(p.memberId, addrDraft)
      if (res && 'error' in res) setError(res.error as string)
      else {
        setAddrEditKey(null)
        router.refresh()
      }
    })
  }
  // 제거 확인은 화면 안에서 받는다 — window.confirm은 미리보기 패널 등 일부 환경에서
  // 대화상자가 뜨지 않아 "눌러도 아무 일 없는" 상태가 된다
  const [docConfirmUrl, setDocConfirmUrl] = useState<string | null>(null)
  function handleDocRemove(p: PersonRow, url: string) {
    setDocConfirmUrl(null)
    startMemberTransition(async () => {
      const res = await removeResidenceDoc(p.memberId, url)
      if (res && 'error' in res) setError(res.error as string)
      else router.refresh()
    })
  }

  // 거주 형태(명부 기본값) 토글 — 주재비 화면의 숙소비 계상 여부가 여기서 갈린다
  const [newResidence, setNewResidence] = useState<ResidenceType>(RESIDENCE_TYPES.LODGING)
  function toggleResidence(p: PersonRow) {
    const next: ResidenceType = p.residenceType === 'commute' ? RESIDENCE_TYPES.LODGING : RESIDENCE_TYPES.COMMUTE
    startMemberTransition(async () => {
      const res = await updateSiteStaffResidence(p.memberId, next)
      if (res && 'error' in res) setError(res.error as string)
      else router.refresh()
    })
  }

  const recordOf = (p: PersonRow, ym: string) =>
    records.find(
      (r) => r.member_id === p.memberId && `${r.year}-${String(r.month).padStart(2, '0')}` === ym,
    )
  const savedDaysOf = (p: PersonRow) => months.reduce((s, ym) => s + (recordOf(p, ym)?.work_days ?? 0), 0)
  const savedVisitsOf = (p: PersonRow) => months.flatMap((ym) => recordOf(p, ym)?.visit_dates ?? []).sort()

  // 상주 출근일수: personKey → 기성기간 합계 / 기술지원: personKey → 방문일 목록
  const [workDays, setWorkDays] = useState<Record<string, string>>(
    Object.fromEntries(persons.map((p) => [p.key, String(savedDaysOf(p))])),
  )
  const [visitDates, setVisitDates] = useState<Record<string, string[]>>(
    Object.fromEntries(persons.map((p) => [p.key, savedVisitsOf(p)])),
  )
  const [pickerValue, setPickerValue] = useState<Record<string, string>>({})

  // 값 출처 (상태 칩) — 초기값은 서버 레코드 기준
  const [source, setSource] = useState<Record<string, ValueSource>>(
    Object.fromEntries(persons.map((p) => [
      p.key,
      (isSupport ? savedVisitsOf(p).length > 0 : savedDaysOf(p) > 0) ? 'saved' : 'empty',
    ])),
  )

  // 자동 인식 결과 — 배너·월별 근거 시트용으로 원본(월별 분해)을 남긴다
  const [isParsing, startParseTransition] = useTransition()
  const [parseNotice, setParseNotice] = useState<{ kind: 'ok' | 'warn'; text: string } | null>(null)
  const [parsedByMonth, setParsedByMonth] = useState<Record<string, Record<string, number>>>({})
  const [parsedFileName, setParsedFileName] = useState<string>('')

  // ── 월별 인식 근거 시트 ──
  const [sheetPersonKey, setSheetPersonKey] = useState<string | null>(null)
  useEffect(() => {
    if (!sheetPersonKey) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setSheetPersonKey(null) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [sheetPersonKey])

  // 기성기간 총 일수(달력 기준) — 합계 입력 상한
  const periodDays =
    Math.round((new Date(periodEnd).getTime() - new Date(periodStart).getTime()) / 86_400_000) + 1

  function addVisitDate(key: string) {
    const d = pickerValue[key]
    if (!d || d < periodStart || d > periodEnd) return
    setVisitDates((prev) => {
      const cur = prev[key] ?? []
      if (cur.includes(d)) return prev
      return { ...prev, [key]: [...cur, d].sort() }
    })
    setPickerValue((prev) => ({ ...prev, [key]: '' }))
    setSource((prev) => ({ ...prev, [key]: 'manual' }))
  }

  function removeVisitDate(key: string, d: string) {
    setVisitDates((prev) => ({ ...prev, [key]: (prev[key] ?? []).filter((x) => x !== d) }))
    setSource((prev) => ({ ...prev, [key]: 'manual' }))
  }

  // 첨부 선택 즉시 PDF에서 기성기간 전체 월의 일수(상주)/방문일(기술지원)을 자동 인식해 채운다.
  // 인식값은 제안일 뿐 — 사용자가 확인·수정 후 저장 버튼으로 확정한다.
  function handleFilesSelected(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []).filter((f) => f.size > 0)
    setPickedNames(files.map((f) => f.name))
    setParseNotice(null)
    if (files.length === 0 || persons.length === 0) return
    const pdf = files.find((f) => f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf'))
    if (!pdf) {
      setParseNotice({ kind: 'warn', text: '이미지 첨부는 자동 인식을 지원하지 않습니다. 값을 직접 입력하세요.' })
      return
    }
    setParsedFileName(pdf.name)
    const fd = new FormData()
    fd.set('staff_type', staffType)
    fd.set('months', months.join(','))
    fd.set('names', JSON.stringify(persons.map((p) => p.name)))
    for (const f of files) fd.append('sheet_files', f)
    startParseTransition(async () => {
      const result = await parseAttendanceSheet(fd)
      if ('error' in result) {
        setParseNotice({ kind: 'warn', text: result.error as string })
        return
      }
      const byName = (name: string) => persons.find((p) => p.name === name)
      // 인식 결과 매칭은 상태 업데이트 함수 밖에서 계산한다 —
      // updater 안에서 채우면 React가 나중에 실행해 안내 문구가 빈 결과로 잘못 뜬다
      if ('workDays' in result && result.workDays) {
        const updates: Record<string, string> = {}
        const monthly: Record<string, Record<string, number>> = {}
        const matched: string[] = []
        for (const [name, byMonth] of Object.entries(result.workDays)) {
          const p = byName(name)
          if (!p) continue
          // 월별 인식값을 합산해 기성기간 합계로 채운다 (월별 분해는 시트 근거로 보존)
          const inPeriod = Object.fromEntries(Object.entries(byMonth).filter(([ym]) => months.includes(ym)))
          const total = Object.values(inPeriod).reduce((s, days) => s + days, 0)
          updates[p.key] = String(total)
          monthly[p.key] = inPeriod
          matched.push(`${name} 합계 ${total}일`)
        }
        if (matched.length > 0) {
          setWorkDays((prev) => ({ ...prev, ...updates }))
          setParsedByMonth((prev) => ({ ...prev, ...monthly }))
          setSource((prev) => ({ ...prev, ...Object.fromEntries(Object.keys(updates).map((k) => [k, 'parsed' as ValueSource])) }))
        }
        setParseNotice(
          matched.length > 0
            ? { kind: 'ok', text: `자동 인식: ${matched.join(', ')} — 확인 후 저장하세요.` }
            : { kind: 'warn', text: '첨부에서 명부 인원의 일수를 찾지 못했습니다. 직접 입력하세요.' },
        )
      }
      if ('visitDates' in result && result.visitDates) {
        const updates: Record<string, string[]> = {}
        const matched: string[] = []
        for (const [name, dates] of Object.entries(result.visitDates)) {
          const p = byName(name)
          if (p) {
            updates[p.key] = dates
            matched.push(`${name} ${dates.length}일`)
          }
        }
        if (matched.length > 0) {
          setVisitDates((prev) => ({ ...prev, ...updates }))
          setSource((prev) => ({ ...prev, ...Object.fromEntries(Object.keys(updates).map((k) => [k, 'parsed' as ValueSource])) }))
        }
        setParseNotice(
          matched.length > 0
            ? { kind: 'ok', text: `방문일 자동 인식: ${matched.join(', ')} — 칩을 확인한 뒤 저장하세요.` }
            : { kind: 'warn', text: '첨부에서 명부 인원의 방문일을 찾지 못했습니다. 직접 입력하세요.' },
        )
      }
    })
  }

  // 첨부 표시 이름 — 업로드 시 URL 프래그먼트에 담아둔 원본 파일명을 쓴다.
  // 프래그먼트가 없는 과거 첨부는 스토리지 파일명(타임스탬프_랜덤.pdf)으로 대체한다.
  function attachmentName(url: string): string {
    const hash = url.split('#')[1]
    if (hash) return decodeURIComponent(hash)
    return decodeURIComponent(url.split('/').pop() ?? '') || '첨부파일'
  }

  // 기존 기록을 비우는 저장의 2단계 확정 플래그 (첫 클릭=경고, 두 번째 클릭=반영)
  const [clearArmed, setClearArmed] = useState(false)

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setError(null)
    setSuccess(false)

    // 빈 저장 차단 — 첨부도 값도 없이 저장하면 "저장되었습니다"만 뜨고 일수가 0으로 덮어써진다.
    // 이미 저장된 값이 있을 때는 "비우기"가 의도일 수 있어 확인만 받는다.
    const hasValue = isSupport
      ? persons.some((p) => (visitDates[p.key] ?? []).length > 0)
      : persons.some((p) => (parseInt(workDays[p.key] ?? '0', 10) || 0) > 0)
    const valueLabel = isSupport ? '방문일' : '출근일수'
    if (!hasValue && keptUrls.length === 0 && pickedNames.length === 0) {
      const hadSaved =
        sheetFileUrls.length > 0 ||
        persons.some((p) => savedDaysOf(p) > 0 || savedVisitsOf(p).length > 0)
      if (!hadSaved) {
        setError(
          isSupport
            ? '첨부와 방문일이 모두 비어 있습니다. 출근부를 첨부하거나 방문일을 입력한 뒤 저장하세요.'
            : '첨부와 출근일수가 모두 비어 있습니다. 출근부를 첨부하거나 출근일수를 입력한 뒤 저장하세요.',
        )
        return
      }
      // 한 번 더 누르면 반영 — 대화상자 대신 경고를 띄우고 같은 버튼으로 확정받는다
      if (!clearArmed) {
        setClearArmed(true)
        setError(`이대로 저장하면 기존에 저장된 첨부와 ${valueLabel} 기록이 지워집니다. 저장을 한 번 더 누르면 반영됩니다.`)
        return
      }
    }
    setClearArmed(false)

    const formData = new FormData(e.currentTarget)
    startTransition(async () => {
      const result = await upsertAttendance(formData)
      if (result && 'error' in result) {
        setError(result.error as string)
      } else {
        setSuccess(true)
        // 저장 성공 — 현재 값이 서버값이 됐으므로 상태 칩을 저장됨으로
        setSource(Object.fromEntries(persons.map((p) => [
          p.key,
          (isSupport ? (visitDates[p.key] ?? []).length > 0 : (parseInt(workDays[p.key] ?? '0', 10) || 0) > 0) ? 'saved' : 'empty',
        ])))
        // 선택 파일은 업로드 완료 — 입력란을 비워 연속 저장 시 같은 파일이 중복 업로드되지 않게 한다
        if (fileInputRef.current) fileInputRef.current.value = ''
        setPickedNames([])
        router.refresh() // 서버 첨부 목록(kept 칩) 갱신
      }
    })
  }

  function handleAddMember() {
    if (!newName.trim()) {
      setError('추가할 인원의 성명을 입력하세요.')
      return
    }
    setError(null)
    const fd = new FormData()
    fd.set('site_id', siteId)
    fd.set('staff_type', staffType)
    fd.set('name', newName)
    fd.set('specialty', newSpecialty)
    fd.set('residence_type', newResidence)
    startMemberTransition(async () => {
      const result = await addSiteStaffMember(fd)
      if (result && 'error' in result) {
        setError(result.error as string)
      } else {
        setNewName('')
        setNewSpecialty('')
        setNewResidence(RESIDENCE_TYPES.LODGING)
        router.refresh()
      }
    })
  }

  // 인원 제외도 확인을 화면 안에서 받는다 (window.confirm 미표시 환경 대응)
  const [removeConfirmId, setRemoveConfirmId] = useState<string | null>(null)
  function handleRemoveMember(memberId: string) {
    setRemoveConfirmId(null)
    startMemberTransition(async () => {
      const result = await deactivateSiteStaffMember(memberId)
      if (result && 'error' in result) {
        setError(result.error as string)
      } else {
        router.refresh()
      }
    })
  }

  // ── 상태 칩 ──
  function statusOf(p: PersonRow): ValueSource {
    const cur = source[p.key] ?? 'empty'
    const hasValue = isSupport
      ? (visitDates[p.key] ?? []).length > 0
      : (parseInt(workDays[p.key] ?? '0', 10) || 0) > 0
    if (!hasValue) return 'empty'
    return cur === 'empty' ? 'manual' : cur
  }
  const STATUS_CHIP: Record<ValueSource, [string, string]> = {
    saved: ['bg-green-50 text-green-700', '✓ 저장됨'],
    parsed: ['bg-blue-50 text-blue-600', '인식됨 — 확인 필요'],
    manual: ['bg-amber-50 text-amber-700', '수기 — 확인 필요'],
    empty: ['bg-gray-100 text-gray-400', '미입력'],
  }

  // 구분별 색 — 상주=보라(주재비 연동), 기술지원=청록(출장비 연동)
  const accent = isSupport
    ? { border: 'border-l-teal-500', chip: 'bg-teal-50 text-teal-700' }
    : { border: 'border-l-purple-500', chip: 'bg-purple-50 text-purple-700' }

  const totalDays = isSupport
    ? persons.reduce((s, p) => s + (visitDates[p.key] ?? []).length, 0)
    : persons.reduce((s, p) => s + (parseInt(workDays[p.key] ?? '0', 10) || 0), 0)

  const hasAttachment = keptUrls.length > 0 || pickedNames.length > 0

  // 방문일을 월별로 묶는다 (칩 그룹 라벨)
  function groupVisits(dates: string[]): [string, string[]][] {
    const map = new Map<string, string[]>()
    for (const d of dates) {
      const ym = d.slice(0, 7)
      if (!map.has(ym)) map.set(ym, [])
      map.get(ym)!.push(d)
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b))
  }

  const specialtyListId = `specialties-${staffType}`
  const sheetPerson = sheetPersonKey ? persons.find((p) => p.key === sheetPersonKey) : undefined
  const sheetMonthly = sheetPersonKey ? parsedByMonth[sheetPersonKey] : undefined

  return (
    <form onSubmit={handleSubmit} className={`overflow-hidden rounded-xl border border-gray-200 border-l-4 ${accent.border} bg-white shadow-sm`}>
      {/* 헤더 */}
      <div className="flex flex-wrap items-center gap-2 px-5 py-3.5">
        <h2 className="text-[15px] font-bold text-gray-900">{STAFF_TYPE_LABELS[staffType]} 출근부</h2>
        <span className={`whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-semibold ${accent.chip}`}>
          {isSupport ? '출장비 방문일 기준' : '식대·출퇴근교통비 산출 기준'}
        </span>
        {hasAttachment ? (
          <span className="whitespace-nowrap rounded-full bg-green-50 px-2 py-0.5 text-[11px] font-semibold text-green-700">
            첨부됨 {keptUrls.length + pickedNames.length}
          </span>
        ) : (
          <span className="whitespace-nowrap rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-semibold text-amber-700">
            미첨부 — 증빙(붙임: 출근부) 누락
          </span>
        )}
        <span className="ml-auto text-sm text-gray-500">
          {persons.length}명 · {isSupport ? '방문일' : '출근일수'} 합계 <b className="text-gray-900">{totalDays}일</b>
        </span>
      </div>

      {error && <div className="border-t border-red-100 bg-red-50 px-5 py-2.5 text-sm text-red-700">{error}</div>}
      {success && <div className="border-t border-green-100 bg-green-50 px-5 py-2.5 text-sm text-green-700">저장되었습니다.</div>}

      <input type="hidden" name="site_id" value={siteId} />
      <input type="hidden" name="round_id" value={roundId} />
      <input type="hidden" name="staff_type" value={staffType} />

      {/* 첨부 스트립 — 현장 작성·서명 출근부 스캔, 기성기간 전체 1부 (원본 증빙) */}
      <div className="flex flex-wrap items-center gap-2 border-t border-gray-100 bg-gray-50/60 px-5 py-2.5">
        <span className="text-xs font-semibold text-gray-500">붙임: 출근부</span>
        {keptUrls.map((url) => (
          <span key={url} className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-2 py-1 text-xs">
            <input type="hidden" name="kept_file_urls" value={url} />
            <span className={`h-2 w-2 rounded-sm ${isSupport ? 'bg-teal-500' : 'bg-purple-500'}`} aria-hidden="true" />
            <a href={url} target="_blank" rel="noreferrer" title={attachmentName(url)}
              className="max-w-[220px] truncate text-blue-600 hover:underline">
              {attachmentName(url)}
            </a>
            <button
              type="button"
              onClick={() => setKeptUrls((prev) => prev.filter((u) => u !== url))}
              className="text-gray-300 hover:text-red-500"
              aria-label="첨부 제거"
            >✕</button>
          </span>
        ))}
        {pickedNames.map((name) => (
          <span key={name} className="inline-flex items-center gap-1.5 rounded-lg border border-dashed border-gray-300 bg-white px-2 py-1 text-xs text-gray-600">
            <span className={`h-2 w-2 rounded-sm ${isSupport ? 'bg-teal-300' : 'bg-purple-300'}`} aria-hidden="true" />
            {name}
            <span className="text-[10px] text-gray-400">(저장 시 업로드)</span>
          </span>
        ))}
        <input
          ref={fileInputRef}
          type="file"
          name="sheet_files"
          multiple
          accept="image/*,application/pdf"
          onChange={handleFilesSelected}
          className="hidden"
        />
        <button type="button" onClick={() => fileInputRef.current?.click()}
          className="rounded-lg border border-dashed border-gray-300 px-2.5 py-1 text-xs font-semibold text-gray-500 hover:border-blue-400 hover:text-blue-600">
          + 첨부 추가 (자동 인식)
        </button>
        <span className="text-[11px] text-gray-400">기성기간 전체 1부 — 스캔·사진 여러 장 가능</span>
      </div>

      {/* 자동 인식 배너 */}
      {isParsing && (
        <div className="border-t border-blue-100 bg-blue-50 px-5 py-2 text-xs text-blue-700">
          🔍 첨부에서 {isSupport ? '방문일' : '출근일수'} 자동 인식 중…
        </div>
      )}
      {parseNotice && !isParsing && (
        <div className={`flex flex-wrap items-center gap-2 border-t px-5 py-2 text-xs ${
          parseNotice.kind === 'ok' ? 'border-blue-100 bg-blue-50 text-blue-700' : 'border-amber-100 bg-amber-50 text-amber-700'
        }`}>
          <span>{parseNotice.kind === 'ok' ? '🔍' : '⚠'} {parseNotice.text}</span>
          {parseNotice.kind === 'ok' && !isSupport && Object.keys(parsedByMonth).length > 0 && (
            <button type="button" onClick={() => setSheetPersonKey(Object.keys(parsedByMonth)[0])}
              className="font-bold underline hover:no-underline">월별 인식 근거</button>
          )}
        </div>
      )}

      {/* 인원 행 */}
      <div className="border-t border-gray-100">
        {/* 열 머리 */}
        <div className={`grid items-center gap-2 px-5 pt-2 pb-1 text-[10.5px] font-semibold text-gray-400 ${
          isSupport ? 'grid-cols-[130px_70px_1fr_64px_150px_28px]' : 'grid-cols-[130px_70px_110px_1fr_150px_28px]'
        }`}>
          <span>성명</span>
          <span>직종</span>
          {!isSupport && <span>거주 형태</span>}
          <span>{isSupport ? '방문일자 (출근부 기재일)' : '출근일수 합계 (기재 일수)'}</span>
          {isSupport && <span className="text-center">합계</span>}
          <span>상태</span>
          <span />
        </div>

        {persons.length === 0 && (
          <p className="px-5 py-4 text-center text-sm text-gray-400">명단이 비어 있습니다. 아래에서 인원을 추가하세요.</p>
        )}

        {persons.map((p) => {
          const st = statusOf(p)
          const [chipCls, chipLabel] = STATUS_CHIP[st]
          return (
            <Fragment key={p.key}>
            <div className={`grid items-center gap-2 border-t border-gray-50 px-5 py-2 text-sm hover:bg-gray-50/60 ${
              isSupport ? 'grid-cols-[130px_70px_1fr_64px_150px_28px]' : 'grid-cols-[130px_70px_110px_1fr_150px_28px]'
            }`}>
              <span>
                <span className="block font-bold text-gray-900">{p.name}</span>
                {/* 거주지 증빙 (재직증명서 등) — 교통비 자택주소의 근거, 사람 단위 1회 첨부 */}
                <input
                  ref={(el) => { docInputs.current[p.key] = el }}
                  type="file"
                  accept="image/*,application/pdf"
                  multiple
                  className="hidden"
                  onChange={(e) => handleDocSelected(p, e)}
                />
                {p.residenceDocUrls.map((url) =>
                  docConfirmUrl === url ? (
                    // 제거 확인 — 같은 자리에서 두 단계로 받는다
                    <span key={url} className="mt-1 inline-flex items-center gap-1 rounded-full bg-red-50 py-0.5 pl-2 pr-1 text-[10.5px] font-semibold text-red-700">
                      제거할까요?
                      <button type="button" onClick={() => handleDocRemove(p, url)} disabled={isMemberPending}
                        className="rounded-full bg-red-600 px-1.5 py-0.5 text-white hover:bg-red-700 disabled:opacity-50">
                        제거
                      </button>
                      <button type="button" onClick={() => setDocConfirmUrl(null)}
                        className="rounded-full px-1.5 py-0.5 text-red-500 hover:bg-red-100">
                        취소
                      </button>
                    </span>
                  ) : (
                    <span key={url} title={attachmentName(url)}
                      className="mt-1 inline-flex max-w-full items-center rounded-full bg-green-50 py-0.5 pl-2 pr-0.5 text-[10.5px] font-semibold text-green-700">
                      <span aria-hidden="true">✓</span>
                      <a href={url} target="_blank" rel="noreferrer" className="ml-1 max-w-[84px] truncate hover:underline">
                        거주지 증빙
                      </a>
                      {/* 제거 버튼 — 링크 오탭 방지: 구분선으로 떼고, 눌리는 영역을 여백 밖까지 넓힌다 */}
                      <span className="ml-1.5 h-3 w-px bg-green-200" aria-hidden="true" />
                      <button type="button" onClick={() => setDocConfirmUrl(url)} disabled={isMemberPending}
                        title="거주지 증빙 제거"
                        className="relative grid h-5 w-5 place-items-center rounded-full text-green-500 after:absolute after:-inset-1 after:content-[''] hover:bg-red-100 hover:text-red-600 disabled:opacity-50"
                        aria-label={`${p.name} 거주지 증빙 제거`}>✕</button>
                    </span>
                  ),
                )}
                {/* 첨부는 여러 부 가능 — 재직증명서 + 등본처럼 서류가 둘 이상일 수 있다 */}
                <button type="button" onClick={() => docInputs.current[p.key]?.click()} disabled={isMemberPending}
                  title="교통비 산출의 자택주소를 확인하는 서류 (재직증명서·주민등록등본 등)"
                  className={`mt-1 inline-flex items-center gap-1 whitespace-nowrap rounded-full py-0.5 text-[10.5px] font-semibold disabled:opacity-50 ${
                    p.residenceDocUrls.length === 0
                      ? 'border border-dashed border-amber-300 bg-amber-50 pl-1.5 pr-2 text-amber-700 hover:border-amber-500 hover:bg-amber-100'
                      : 'px-1.5 text-gray-400 hover:bg-gray-100 hover:text-blue-600'
                  }`}>
                  {p.residenceDocUrls.length === 0
                    ? <><span aria-hidden="true">📄</span> 거주지 증빙 첨부</>
                    : '+ 증빙 추가'}
                </button>

                {/* 자택주소 — 증빙에서 인식된 값이 교통비·출장비 산출로 자동 매핑된다 */}
                <span className="mt-0.5 flex max-w-full items-center gap-1">
                  <button type="button"
                    onClick={() => { setAddrEditKey(p.key); setAddrDraft(p.homeAddress ?? ''); setAddrNotice(null) }}
                    title={p.homeAddress ? `자택주소: ${p.homeAddress} (클릭해 수정)` : '자택주소 입력 — 교통비 산출의 출발지'}
                    className={`min-w-0 truncate text-left text-[10.5px] hover:underline ${
                      p.homeAddress ? 'text-gray-500' : 'text-gray-300'
                    }`}>
                    🏠 {p.homeAddress ?? '자택주소 미입력'}
                  </button>
                  {/* 첨부는 있는데 주소가 비었을 때 — 업로드 시점에 인식하지 못한 증빙을 다시 읽는다 */}
                  {!p.homeAddress && p.residenceDocUrls.length > 0 && (
                    <button type="button" onClick={() => handleAddrReparse(p)} disabled={isMemberPending}
                      title="첨부된 증빙에서 자택주소를 다시 인식합니다"
                      className="flex-none whitespace-nowrap rounded-full bg-blue-50 px-1.5 py-0.5 text-[10px] font-semibold text-blue-600 hover:bg-blue-100 disabled:opacity-50">
                      {isMemberPending ? '…' : '주소 인식'}
                    </button>
                  )}
                </span>
              </span>
              <span>
                {p.specialty && (
                  <span className="whitespace-nowrap rounded-full bg-gray-100 px-2 py-0.5 text-[11px] font-semibold text-gray-500">{p.specialty}</span>
                )}
              </span>

              {/* 거주 형태 칩 토글 — 상주만 (숙소비 계상 여부·교통비 승수를 가른다) */}
              {!isSupport && (
                <span>
                  <button
                    type="button"
                    onClick={() => toggleResidence(p)}
                    disabled={isMemberPending}
                    title="클릭하면 거주 형태가 바뀝니다 (명부 기본값)"
                    className={`whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-semibold transition-colors disabled:opacity-50 ${
                      p.residenceType === 'commute'
                        ? 'bg-sky-100 text-sky-700 hover:bg-sky-200'
                        : 'bg-purple-100 text-purple-700 hover:bg-purple-200'
                    }`}
                  >
                    {RESIDENCE_TYPE_ICONS[p.residenceType]} {RESIDENCE_TYPE_LABELS[p.residenceType]}
                  </button>
                </span>
              )}

              {isSupport ? (
                <>
                  <span>
                    <input type="hidden" name={`visit_dates_${p.key}`} value={(visitDates[p.key] ?? []).join(',')} />
                    <span className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
                      {groupVisits(visitDates[p.key] ?? []).map(([ym, dates]) => (
                        <span key={ym} className="inline-flex items-center gap-1">
                          <span className="text-[10.5px] font-bold text-gray-400">{ym.slice(2)}</span>
                          {dates.map((d) => (
                            <span key={d} className="inline-flex items-center gap-1 rounded-md bg-teal-50 px-1.5 py-0.5 text-[11px] font-semibold text-teal-700">
                              {d.slice(8)}
                              <button type="button" onClick={() => removeVisitDate(p.key, d)}
                                className="text-teal-400 hover:text-red-500" aria-label={`${d} 제거`}>✕</button>
                            </span>
                          ))}
                        </span>
                      ))}
                      <input
                        type="date"
                        min={periodStart}
                        max={periodEnd}
                        value={pickerValue[p.key] ?? ''}
                        onChange={(e) => setPickerValue((prev) => ({ ...prev, [p.key]: e.target.value }))}
                        className="rounded border border-gray-300 px-1.5 py-0.5 text-xs focus:border-blue-500 focus:outline-none"
                      />
                      <button type="button" onClick={() => addVisitDate(p.key)}
                        className="rounded border border-dashed border-gray-300 px-1.5 py-0.5 text-[11px] font-semibold text-gray-400 hover:border-teal-500 hover:text-teal-600">
                        + 날짜
                      </button>
                    </span>
                  </span>
                  <span className="text-center font-bold text-gray-900">{(visitDates[p.key] ?? []).length}일</span>
                </>
              ) : (
                <span className="flex items-center gap-1.5">
                  <input
                    name={`work_days_${p.key}`}
                    type="number"
                    min={0}
                    max={periodDays}
                    value={workDays[p.key] ?? '0'}
                    onChange={(e) => {
                      setWorkDays((prev) => ({ ...prev, [p.key]: e.target.value }))
                      setSource((prev) => ({ ...prev, [p.key]: 'manual' }))
                    }}
                    className="w-20 rounded-md border border-gray-300 px-2 py-1 text-center text-sm font-semibold focus:border-blue-500 focus:outline-none"
                  />
                  <span className="text-xs text-gray-400">일 / {periodDays}일</span>
                  {parsedByMonth[p.key] && (
                    <button type="button" onClick={() => setSheetPersonKey(p.key)}
                      className="text-xs font-semibold text-blue-600 hover:underline">월별 근거</button>
                  )}
                </span>
              )}

              <span>
                <span className={`whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-semibold ${chipCls}`}>{chipLabel}</span>
              </span>
              <button
                type="button"
                onClick={() => setRemoveConfirmId(p.memberId)}
                disabled={isMemberPending}
                className="grid h-6 w-6 place-items-center rounded text-gray-300 hover:bg-red-50 hover:text-red-500 disabled:opacity-50"
                title="명단에서 제외"
                aria-label={`${p.name} 명단에서 제외`}
              >✕</button>
            </div>

            {/* 자택주소 인식 결과 안내 — 첨부 직후 1회 */}
            {addrNotice?.key === p.key && (
              <div className={`flex flex-wrap items-center gap-2 border-t px-5 py-2 text-xs ${
                addrNotice.ok ? 'border-blue-100 bg-blue-50 text-blue-700' : 'border-amber-100 bg-amber-50 text-amber-700'
              }`}>
                <span>{addrNotice.ok ? '🏠' : '⚠'} {addrNotice.text}</span>
                <button type="button" onClick={() => { setAddrEditKey(p.key); setAddrDraft(p.homeAddress ?? ''); setAddrNotice(null) }}
                  className="font-bold underline hover:no-underline">주소 수정</button>
                <button type="button" onClick={() => setAddrNotice(null)}
                  className="ml-auto text-gray-400 hover:text-gray-600" aria-label="안내 닫기">✕</button>
              </div>
            )}

            {/* 자택주소 입력 — 인식 실패·오인식 보정 (교통비 산출 출발지) */}
            {addrEditKey === p.key && (
              <div className="flex flex-wrap items-center gap-2 border-t border-gray-100 bg-gray-50 px-5 py-2 text-xs">
                <label className="font-semibold text-gray-600">{p.name} 자택주소</label>
                <input
                  type="text"
                  value={addrDraft}
                  onChange={(e) => setAddrDraft(e.target.value)}
                  placeholder="예: 충북 청주시 상당구 ○○로 123"
                  className="min-w-[240px] flex-1 rounded border border-gray-300 px-2 py-1 text-xs focus:border-blue-500 focus:outline-none"
                />
                <button type="button" onClick={() => handleAddrSave(p)} disabled={isMemberPending}
                  className="rounded-lg bg-blue-600 px-2.5 py-1 font-semibold text-white hover:bg-blue-700 disabled:opacity-50">
                  저장
                </button>
                <button type="button" onClick={() => setAddrEditKey(null)}
                  className="rounded-lg border border-gray-300 bg-white px-2.5 py-1 font-semibold text-gray-600 hover:bg-gray-100">
                  취소
                </button>
                <span className="w-full text-[11px] text-gray-400">
                  교통비·출장비 산출의 출발지로 자동 사용됩니다 (자택↔현장 거리).
                </span>
              </div>
            )}

            {/* 제외 확인 — 마지막 열이 좁아 행 아래 띠로 받는다 (대화상자 미사용) */}
            {removeConfirmId === p.memberId && (
              <div className="flex flex-wrap items-center gap-2 border-t border-red-100 bg-red-50 px-5 py-2 text-xs text-red-700">
                <span>
                  <b>{p.name}</b> 님을 명단에서 제외할까요? 과거 출근부 기록은 보존되고, 이후 정산 인원에서만 빠집니다.
                </span>
                <span className="ml-auto flex items-center gap-1.5">
                  <button type="button" onClick={() => handleRemoveMember(p.memberId)} disabled={isMemberPending}
                    className="rounded-lg bg-red-600 px-2.5 py-1 font-semibold text-white hover:bg-red-700 disabled:opacity-50">
                    제외
                  </button>
                  <button type="button" onClick={() => setRemoveConfirmId(null)}
                    className="rounded-lg border border-red-200 bg-white px-2.5 py-1 font-semibold text-red-600 hover:bg-red-100">
                    취소
                  </button>
                </span>
              </div>
            )}
            </Fragment>
          )
        })}
      </div>

      {/* 하단 — 인원 추가 + 저장 */}
      <div className="flex flex-wrap items-center gap-2 border-t border-gray-100 bg-gray-50/60 px-5 py-2.5">
        <input
          type="text"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          placeholder="성명"
          className="w-24 rounded-md border border-gray-300 px-2 py-1.5 text-sm focus:border-blue-500 focus:outline-none"
        />
        <input
          type="text"
          list={specialtyListId}
          value={newSpecialty}
          onChange={(e) => setNewSpecialty(e.target.value)}
          placeholder="직종 (예: 건축)"
          className="w-28 rounded-md border border-gray-300 px-2 py-1.5 text-sm focus:border-blue-500 focus:outline-none"
        />
        <datalist id={specialtyListId}>
          {SPECIALTIES.map((s) => <option key={s} value={s} />)}
        </datalist>
        {!isSupport && (
          <button
            type="button"
            onClick={() => setNewResidence((v) => v === 'commute' ? RESIDENCE_TYPES.LODGING : RESIDENCE_TYPES.COMMUTE)}
            title="추가할 인원의 거주 형태 (클릭해 전환)"
            className={`whitespace-nowrap rounded-full px-2 py-1 text-[11px] font-semibold ${
              newResidence === 'commute' ? 'bg-sky-100 text-sky-700' : 'bg-purple-100 text-purple-700'
            }`}
          >
            {RESIDENCE_TYPE_ICONS[newResidence]} {RESIDENCE_TYPE_LABELS[newResidence]}
          </button>
        )}
        <button
          type="button"
          onClick={handleAddMember}
          disabled={isMemberPending}
          className="rounded-lg border border-dashed border-gray-300 px-2.5 py-1.5 text-xs font-semibold text-gray-500 hover:border-blue-400 hover:text-blue-600 disabled:opacity-50"
        >
          + 인원 추가
        </button>
        <span className="text-[11px] text-gray-400">로그인 계정이 없는 기술인도 추가 — 명부가 정산 인원의 단일 원천</span>
        <div className="ml-auto">
          <Button type="submit" loading={isPending}>
            {STAFF_TYPE_LABELS[staffType]} 출근부 저장
          </Button>
        </div>
      </div>

      {/* 우측 시트 — 자동 인식 월별 근거 */}
      {sheetPerson && sheetMonthly && (
        <>
          <div className="fixed inset-0 z-40 bg-gray-900/40" onClick={() => setSheetPersonKey(null)} aria-hidden="true" />
          <aside role="dialog" aria-modal="true" aria-label="자동 인식 월별 근거"
            className="fixed inset-y-0 right-0 z-50 flex w-[min(430px,92vw)] flex-col bg-white shadow-2xl">
            <div className="flex items-start justify-between border-b border-gray-200 px-5 py-4">
              <div>
                <h3 className="text-[15px] font-bold text-gray-900">자동 인식 — 월별 근거</h3>
                <p className="mt-0.5 text-xs text-gray-500">
                  {sheetPerson.name}{sheetPerson.specialty ? ` (${sheetPerson.specialty})` : ''}{parsedFileName ? ` · ${parsedFileName}` : ''}
                </p>
              </div>
              <button type="button" onClick={() => setSheetPersonKey(null)} aria-label="닫기"
                className="rounded-lg bg-gray-100 px-2.5 py-1 text-sm text-gray-500 hover:bg-gray-200">✕</button>
            </div>
            <div className="flex-1 space-y-4 overflow-y-auto px-5 py-4">
              <div className="rounded-lg border border-gray-200 p-3.5 text-sm">
                <p className="mb-2 flex items-center justify-between text-xs font-semibold text-gray-500">
                  월별 인식 일수
                  <span className="rounded-full bg-blue-50 px-2 py-0.5 text-[11px] font-semibold text-blue-600">PDF 텍스트 인식</span>
                </p>
                {months.map((ym) => (
                  <div key={ym} className="flex justify-between py-0.5">
                    <span className="text-gray-500">{ym}</span>
                    <b>{sheetMonthly[ym] ?? 0}일</b>
                  </div>
                ))}
                <div className="mt-1.5 flex justify-between border-t border-gray-100 pt-1.5">
                  <span className="font-semibold text-gray-700">기성기간 합계</span>
                  <b>{Object.values(sheetMonthly).reduce((s, v) => s + v, 0)}일</b>
                </div>
                <p className="mt-2.5 rounded-md bg-gray-50 p-2.5 text-xs text-gray-500">
                  저장 시 합계는 회차 시작 월({months[0]}) 레코드에 기록됩니다. 이 값이 식대(횟수×단가)·출퇴근교통비(왕복비×근무일수) 산출의 기준입니다.
                </p>
              </div>
              {/* 다른 인식 인원으로 전환 */}
              {Object.keys(parsedByMonth).length > 1 && (
                <div className="flex flex-wrap gap-1.5">
                  {Object.keys(parsedByMonth).map((key) => {
                    const person = persons.find((x) => x.key === key)
                    if (!person) return null
                    return (
                      <button key={key} type="button" onClick={() => setSheetPersonKey(key)}
                        className={`rounded-full px-3 py-1 text-xs font-semibold ${
                          key === sheetPersonKey ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                        }`}>
                        {person.name}
                      </button>
                    )
                  })}
                </div>
              )}
            </div>
            <div className="border-t border-gray-200 px-5 py-3.5">
              <button type="button" onClick={() => setSheetPersonKey(null)}
                className="w-full rounded-lg border border-gray-300 py-2.5 text-sm font-semibold text-gray-700 hover:bg-gray-50">
                닫기
              </button>
            </div>
          </aside>
        </>
      )}
    </form>
  )
}
