'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/Button'
import { upsertAttendance, addSiteStaffMember, deactivateSiteStaffMember, parseAttendanceSheet } from '@/actions/attendance'
import { STAFF_TYPE_LABELS, SPECIALTIES, type StaffType } from '@/lib/constants'
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
}

// 출근부 구분 섹션 — 기성회차 단위. 출근부 1부를 첨부하고(자동 인식),
// 상주는 인원×월 그리드로 일수를, 기술지원은 기간 내 방문일을 한 번에 전기한다.
// 저장은 월별 레코드로 들어간다(식대·교통비·출장비 산출이 월 단위).
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
  // 인원 추가 입력
  const [newName, setNewName] = useState('')
  const [newSpecialty, setNewSpecialty] = useState('')

  const persons: PersonRow[] = members.map((m) => ({
    key: `m_${m.id}`, name: m.name, specialty: m.specialty, memberId: m.id,
  }))

  const recordOf = (p: PersonRow, ym: string) =>
    records.find(
      (r) => r.member_id === p.memberId && `${r.year}-${String(r.month).padStart(2, '0')}` === ym,
    )

  // 상주 출근일수 상태: personKey → 기성기간 합계 (자동 인식이 채울 수 있도록 controlled)
  // 저장 시 합계는 회차 시작 월 레코드에 기록되므로, 표시값도 기간 내 레코드 합으로 복원한다
  const [workDays, setWorkDays] = useState<Record<string, string>>(
    Object.fromEntries(
      persons.map((p) => [
        p.key,
        String(months.reduce((s, ym) => s + (recordOf(p, ym)?.work_days ?? 0), 0)),
      ]),
    ),
  )
  // 기술지원 방문일자 상태: personKey → 기간 전체 dates[]
  const [visitDates, setVisitDates] = useState<Record<string, string[]>>(
    Object.fromEntries(
      persons.map((p) => [
        p.key,
        months.flatMap((ym) => recordOf(p, ym)?.visit_dates ?? []).sort(),
      ]),
    ),
  )
  const [pickerValue, setPickerValue] = useState<Record<string, string>>({})
  // 첨부 자동 인식 상태
  const [isParsing, startParseTransition] = useTransition()
  const [parseNotice, setParseNotice] = useState<{ kind: 'ok' | 'warn'; text: string } | null>(null)

  const isSupport = staffType === 'support'
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
  }

  function removeVisitDate(key: string, d: string) {
    setVisitDates((prev) => ({ ...prev, [key]: (prev[key] ?? []).filter((x) => x !== d) }))
  }

  // 첨부 선택 즉시 PDF에서 기성기간 전체 월의 일수(상주)/방문일(기술지원)을 자동 인식해 채운다.
  // 인식값은 제안일 뿐 — 사용자가 확인·수정 후 저장 버튼으로 확정한다.
  function handleFilesSelected(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []).filter((f) => f.size > 0)
    setParseNotice(null)
    if (files.length === 0 || persons.length === 0) return
    if (!files.some((f) => f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf'))) {
      setParseNotice({ kind: 'warn', text: '이미지 첨부는 자동 인식을 지원하지 않습니다. 값을 직접 입력하세요.' })
      return
    }
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
        const matched: string[] = []
        for (const [name, byMonth] of Object.entries(result.workDays)) {
          const p = byName(name)
          if (!p) continue
          // 월별 인식값을 합산해 기성기간 합계로 채운다
          const total = Object.entries(byMonth)
            .filter(([ym]) => months.includes(ym))
            .reduce((s, [, days]) => s + days, 0)
          updates[p.key] = String(total)
          matched.push(`${name} 합계 ${total}일`)
        }
        if (matched.length > 0) setWorkDays((prev) => ({ ...prev, ...updates }))
        setParseNotice(
          matched.length > 0
            ? { kind: 'ok', text: `출근부에서 자동 인식: ${matched.join(', ')} — 확인 후 저장하세요.` }
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
        if (matched.length > 0) setVisitDates((prev) => ({ ...prev, ...updates }))
        setParseNotice(
          matched.length > 0
            ? { kind: 'ok', text: `출근부에서 방문일 자동 인식: ${matched.join(', ')} — 확인 후 저장하세요.` }
            : { kind: 'warn', text: '첨부에서 명부 인원의 방문일을 찾지 못했습니다. 직접 입력하세요.' },
        )
      }
    })
  }

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setError(null)
    setSuccess(false)
    const formData = new FormData(e.currentTarget)
    startTransition(async () => {
      const result = await upsertAttendance(formData)
      if (result && 'error' in result) {
        setError(result.error as string)
      } else {
        setSuccess(true)
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
    startMemberTransition(async () => {
      const result = await addSiteStaffMember(fd)
      if (result && 'error' in result) {
        setError(result.error as string)
      } else {
        setNewName('')
        setNewSpecialty('')
        router.refresh()
      }
    })
  }

  function handleRemoveMember(memberId: string, name: string) {
    if (!window.confirm(`${name} 님을 명단에서 제외할까요? (과거 출근부 기록은 보존됩니다)`)) return
    startMemberTransition(async () => {
      const result = await deactivateSiteStaffMember(memberId)
      if (result && 'error' in result) {
        setError(result.error as string)
      } else {
        router.refresh()
      }
    })
  }

  const specialtyListId = `specialties-${staffType}`

  return (
    <form onSubmit={handleSubmit} className="rounded-xl border border-gray-200 bg-white p-6 space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-base font-semibold text-gray-900">{STAFF_TYPE_LABELS[staffType]} 출근부</h2>
        <span className="rounded bg-gray-100 px-2 py-0.5 text-xs text-gray-500">
          {isSupport ? '출장비 방문일 기준' : '식대·출퇴근교통비 산출 기준'}
        </span>
        <span className="text-xs text-gray-400">{periodStart} ~ {periodEnd}</span>
      </div>

      {error && <div className="rounded-md bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}
      {success && <div className="rounded-md bg-green-50 px-4 py-3 text-sm text-green-700">저장되었습니다.</div>}

      <input type="hidden" name="site_id" value={siteId} />
      <input type="hidden" name="round_id" value={roundId} />
      <input type="hidden" name="staff_type" value={staffType} />

      {/* 첨부 — 현장 작성·서명 출근부 스캔, 기성기간 전체 1부 (원본 증빙) */}
      <div className="space-y-2">
        <label className="block text-sm font-medium text-gray-700">
          출근부 첨부 <span className="text-xs font-normal text-gray-400">(기성기간 전체 1부 — 스캔·사진 여러 장 가능, 정산서 붙임 증빙)</span>
        </label>
        {keptUrls.length > 0 && (
          <ul className="space-y-1">
            {keptUrls.map((url) => (
              <li key={url} className="flex items-center gap-2 text-sm">
                <input type="hidden" name="kept_file_urls" value={url} />
                <a href={url} target="_blank" rel="noreferrer" className="text-blue-600 hover:underline truncate max-w-md">
                  {decodeURIComponent(url.split('/').pop() ?? '첨부파일')}
                </a>
                <button
                  type="button"
                  onClick={() => setKeptUrls((prev) => prev.filter((u) => u !== url))}
                  className="rounded px-1.5 text-xs text-red-500 hover:bg-red-50"
                  aria-label="첨부 제거"
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
        )}
        <input
          type="file"
          name="sheet_files"
          multiple
          accept="image/*,application/pdf"
          onChange={handleFilesSelected}
          className="block w-full text-sm text-gray-600 file:mr-3 file:rounded-md file:border-0 file:bg-blue-50 file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-blue-700 hover:file:bg-blue-100"
        />
        {isParsing && (
          <p className="text-xs text-blue-600">첨부에서 {isSupport ? '방문일' : '출근일수'} 자동 인식 중…</p>
        )}
        {parseNotice && (
          <p className={`text-xs ${parseNotice.kind === 'ok' ? 'text-green-700' : 'text-amber-600'}`}>
            {parseNotice.kind === 'ok' ? '✓ ' : '⚠ '}
            {parseNotice.text}
          </p>
        )}
        {keptUrls.length === 0 && sheetFileUrls.length === 0 && (
          <p className="text-xs text-amber-600">
            ⚠ 출근부 미첨부 — 첨부 없이 저장하면 {isSupport ? '출장비' : '식대·교통비'} 증빙(붙임: 출근부)이 누락됩니다.
          </p>
        )}
      </div>

      {/* 인원별 전기 — 상주: 인원×월 일수 그리드 / 기술지원: 기간 전체 방문일 */}
      <div className="overflow-hidden rounded-lg border border-gray-200">
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200 text-sm">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-4 py-2.5 text-left font-medium text-gray-500 whitespace-nowrap">성명 (직종)</th>
                {isSupport ? (
                  <>
                    <th className="px-4 py-2.5 text-left font-medium text-gray-500">방문일자 (출근부 기재일)</th>
                    <th className="px-3 py-2.5 text-center font-medium text-gray-500 whitespace-nowrap">합계</th>
                  </>
                ) : (
                  <th className="px-4 py-2.5 text-center font-medium text-gray-500 whitespace-nowrap">
                    출근일수 합계 (출근부 기재 일수)
                  </th>
                )}
                <th className="w-12 px-2 py-2.5" />
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 bg-white">
              {persons.length === 0 && (
                <tr>
                  <td colSpan={isSupport ? 4 : 3} className="px-4 py-4 text-center text-sm text-gray-400">
                    명단이 비어 있습니다. 아래에서 인원을 추가하세요.
                  </td>
                </tr>
              )}
              {persons.map((p) => (
                <tr key={p.key}>
                  <td className="px-4 py-3 text-gray-700 whitespace-nowrap">
                    {p.name}
                    {p.specialty && <span className="ml-1 text-xs text-gray-400">({p.specialty})</span>}
                  </td>
                  {isSupport ? (
                    <>
                      <td className="px-4 py-2">
                        <input type="hidden" name={`visit_dates_${p.key}`} value={(visitDates[p.key] ?? []).join(',')} />
                        <div className="flex flex-wrap items-center gap-1.5">
                          {(visitDates[p.key] ?? []).map((d) => (
                            <span key={d} className="inline-flex items-center gap-1 rounded-full bg-blue-50 px-2 py-0.5 text-xs text-blue-700">
                              {d.slice(2)}
                              <button
                                type="button"
                                onClick={() => removeVisitDate(p.key, d)}
                                className="text-blue-400 hover:text-red-500"
                                aria-label={`${d} 제거`}
                              >
                                ✕
                              </button>
                            </span>
                          ))}
                          <input
                            type="date"
                            min={periodStart}
                            max={periodEnd}
                            value={pickerValue[p.key] ?? ''}
                            onChange={(e) => setPickerValue((prev) => ({ ...prev, [p.key]: e.target.value }))}
                            className="rounded border border-gray-300 px-2 py-1 text-xs"
                          />
                          <button
                            type="button"
                            onClick={() => addVisitDate(p.key)}
                            className="rounded bg-gray-100 px-2 py-1 text-xs text-gray-600 hover:bg-gray-200"
                          >
                            추가
                          </button>
                        </div>
                      </td>
                      <td className="px-3 py-3 text-center font-medium text-gray-900 whitespace-nowrap">
                        {(visitDates[p.key] ?? []).length}일
                      </td>
                    </>
                  ) : (
                    <td className="px-4 py-2 text-center">
                      <input
                        name={`work_days_${p.key}`}
                        type="number"
                        min={0}
                        max={periodDays}
                        value={workDays[p.key] ?? '0'}
                        onChange={(e) =>
                          setWorkDays((prev) => ({ ...prev, [p.key]: e.target.value }))
                        }
                        className="w-24 rounded-md border border-gray-300 px-2 py-1.5 text-center text-sm focus:border-blue-500 focus:outline-none"
                      />
                      <span className="ml-1 text-sm text-gray-500">일</span>
                    </td>
                  )}
                  <td className="px-2 py-3 text-center">
                    <button
                      type="button"
                      onClick={() => handleRemoveMember(p.memberId, p.name)}
                      disabled={isMemberPending}
                      className="rounded px-1.5 text-xs text-gray-400 hover:bg-red-50 hover:text-red-500"
                      title="명단에서 제외"
                    >
                      ✕
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* 인원 추가 — 로그인 계정이 없는 기술인을 명부에 등록 */}
        <div className="flex flex-wrap items-center gap-2 border-t border-gray-200 bg-gray-50 px-4 py-3">
          <input
            type="text"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="성명"
            className="w-28 rounded-md border border-gray-300 px-2 py-1.5 text-sm focus:border-blue-500 focus:outline-none"
          />
          <input
            type="text"
            list={specialtyListId}
            value={newSpecialty}
            onChange={(e) => setNewSpecialty(e.target.value)}
            placeholder="직종 (예: 건축)"
            className="w-32 rounded-md border border-gray-300 px-2 py-1.5 text-sm focus:border-blue-500 focus:outline-none"
          />
          <datalist id={specialtyListId}>
            {SPECIALTIES.map((s) => <option key={s} value={s} />)}
          </datalist>
          <button
            type="button"
            onClick={handleAddMember}
            disabled={isMemberPending}
            className="rounded-md border border-blue-300 bg-blue-50 px-3 py-1.5 text-sm font-medium text-blue-700 hover:bg-blue-100 disabled:opacity-50"
          >
            + 인원 추가
          </button>
          <span className="text-xs text-gray-400">로그인 계정이 없는 기술인도 추가할 수 있습니다</span>
        </div>
      </div>

      <div className="flex justify-end">
        <Button type="submit" loading={isPending}>
          {STAFF_TYPE_LABELS[staffType]} 출근부 저장
        </Button>
      </div>
    </form>
  )
}
