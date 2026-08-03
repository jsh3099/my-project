'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/Button'
import { upsertAttendance, addSiteStaffMember, deactivateSiteStaffMember } from '@/actions/attendance'
import { STAFF_TYPE_LABELS, SPECIALTIES, type StaffType } from '@/lib/constants'
import type { Profile, AttendanceRecord, AttendanceSheet, SiteStaffMember } from '@/types'

interface Props {
  siteId: string
  year: number
  month: number
  staffType: StaffType
  users: Profile[]         // 로그인 계정 인원 (현장 배정)
  members: SiteStaffMember[] // 기술인 명부 인원 (화면에서 추가)
  records: AttendanceRecord[]
  sheet: AttendanceSheet | null
}

// 통합 인원 행 — 계정 인원(key=userId)과 명부 인원(key=m_{memberId})을 한 표로
type PersonRow = {
  key: string
  name: string
  specialty: string | null
  memberId: string | null // 명부 인원만 제외(비활성) 가능
}

// 출근부 구분 섹션 — 첨부(현장 작성·서명본 스캔) + 인원별 일수(상주)/방문일(기술지원) 전기
export function AttendanceSheetSection({ siteId, year, month, staffType, users, members, records, sheet }: Props) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [isMemberPending, startMemberTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)
  // 기존 첨부 중 유지할 것 (X 클릭 시 제외 → 저장 시 삭제 처리)
  const [keptUrls, setKeptUrls] = useState<string[]>(sheet?.file_urls ?? [])
  // 인원 추가 입력
  const [newName, setNewName] = useState('')
  const [newSpecialty, setNewSpecialty] = useState('')

  const persons: PersonRow[] = [
    ...users.map((u) => ({ key: u.id, name: u.full_name, specialty: null, memberId: null })),
    ...members.map((m) => ({ key: `m_${m.id}`, name: m.name, specialty: m.specialty, memberId: m.id })),
  ]

  const recordOf = (p: PersonRow) =>
    records.find((r) => (p.memberId ? r.member_id === p.memberId : r.user_id === p.key))

  // 기술지원 방문일자 상태: personKey → dates[]
  const [visitDates, setVisitDates] = useState<Record<string, string[]>>(
    Object.fromEntries(persons.map((p) => [p.key, recordOf(p)?.visit_dates ?? []])),
  )
  const [pickerValue, setPickerValue] = useState<Record<string, string>>({})

  const isSupport = staffType === 'support'
  const ym = `${year}-${String(month).padStart(2, '0')}`
  const monthDays = new Date(year, month, 0).getDate()

  function addVisitDate(key: string) {
    const d = pickerValue[key]
    if (!d || !d.startsWith(ym)) return
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
      <div className="flex items-center gap-2">
        <h2 className="text-base font-semibold text-gray-900">{STAFF_TYPE_LABELS[staffType]} 출근부</h2>
        <span className="rounded bg-gray-100 px-2 py-0.5 text-xs text-gray-500">
          {isSupport ? '출장비 방문일 기준' : '식대·출퇴근교통비 산출 기준'}
        </span>
      </div>

      {error && <div className="rounded-md bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}
      {success && <div className="rounded-md bg-green-50 px-4 py-3 text-sm text-green-700">저장되었습니다.</div>}

      <input type="hidden" name="site_id" value={siteId} />
      <input type="hidden" name="year" value={year} />
      <input type="hidden" name="month" value={month} />
      <input type="hidden" name="staff_type" value={staffType} />

      {/* 첨부 — 현장 작성·서명 출근부 스캔 (원본 증빙) */}
      <div className="space-y-2">
        <label className="block text-sm font-medium text-gray-700">
          출근부 첨부 <span className="text-xs font-normal text-gray-400">(스캔·사진, 여러 장 가능 — 정산서 붙임 증빙)</span>
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
          className="block w-full text-sm text-gray-600 file:mr-3 file:rounded-md file:border-0 file:bg-blue-50 file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-blue-700 hover:file:bg-blue-100"
        />
        {keptUrls.length === 0 && !sheet?.file_urls.length && (
          <p className="text-xs text-amber-600">
            ⚠ 출근부 미첨부 — 첨부 없이 저장하면 {isSupport ? '출장비' : '식대·교통비'} 증빙(붙임: 출근부)이 누락됩니다.
          </p>
        )}
      </div>

      {/* 인원별 전기 */}
      <div className="overflow-hidden rounded-lg border border-gray-200">
        <table className="min-w-full divide-y divide-gray-200 text-sm">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-4 py-2.5 text-left font-medium text-gray-500">성명 (직종)</th>
              {isSupport ? (
                <th className="px-4 py-2.5 text-left font-medium text-gray-500">방문일자 (출근부 기재일)</th>
              ) : (
                <th className="px-4 py-2.5 text-center font-medium text-gray-500">출근일수 (출근부 기재 일수)</th>
              )}
              <th className="w-12 px-2 py-2.5" />
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100 bg-white">
            {persons.length === 0 && (
              <tr>
                <td colSpan={3} className="px-4 py-4 text-center text-sm text-gray-400">
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
                  <td className="px-4 py-2">
                    <input type="hidden" name={`visit_dates_${p.key}`} value={(visitDates[p.key] ?? []).join(',')} />
                    <div className="flex flex-wrap items-center gap-1.5">
                      {(visitDates[p.key] ?? []).map((d) => (
                        <span key={d} className="inline-flex items-center gap-1 rounded-full bg-blue-50 px-2 py-0.5 text-xs text-blue-700">
                          {d.slice(5).replace('-', '/')}
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
                        min={`${ym}-01`}
                        max={`${ym}-${String(monthDays).padStart(2, '0')}`}
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
                      <span className="ml-1 text-xs text-gray-400">{(visitDates[p.key] ?? []).length}일</span>
                    </div>
                  </td>
                ) : (
                  <td className="px-4 py-2 text-center">
                    <input
                      name={`work_days_${p.key}`}
                      type="number"
                      min={0}
                      max={monthDays}
                      defaultValue={recordOf(p)?.work_days ?? 0}
                      className="w-20 rounded-md border border-gray-300 px-2 py-1.5 text-center text-sm focus:border-blue-500 focus:outline-none"
                    />
                  </td>
                )}
                <td className="px-2 py-3 text-center">
                  {p.memberId && (
                    <button
                      type="button"
                      onClick={() => handleRemoveMember(p.memberId!, p.name)}
                      disabled={isMemberPending}
                      className="rounded px-1.5 text-xs text-gray-400 hover:bg-red-50 hover:text-red-500"
                      title="명단에서 제외"
                    >
                      ✕
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>

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
