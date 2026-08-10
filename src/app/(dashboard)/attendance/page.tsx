import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { AttendanceSheetSection } from '@/components/attendance/AttendanceSheetSection'
import { RoundPeriodEditor } from '@/components/settlement/RoundPeriodEditor'
import type { StaffType } from '@/lib/constants'
import type { Site, AttendanceRecord, AttendanceSheet, SiteStaffMember, SettlementRound } from '@/types'

const pad = (n: number) => String(n).padStart(2, '0')

// 회차 기성기간(period_start~period_end)에 걸치는 연월 목록 ("YYYY-MM", 최대 24개월 안전 상한)
function monthsOfRound(round: SettlementRound): string[] {
  const months: string[] = []
  const [sy, sm] = round.period_start.slice(0, 7).split('-').map(Number)
  const [ey, em] = round.period_end.slice(0, 7).split('-').map(Number)
  let y = sy
  let m = sm
  while ((y < ey || (y === ey && m <= em)) && months.length < 24) {
    months.push(`${y}-${pad(m)}`)
    m += 1
    if (m > 12) {
      m = 1
      y += 1
    }
  }
  return months
}

// 출근부: 현장이 실제 근무일을 작성·서명한 출근부를 기성회차 단위로 첨부하고(1부),
// 상주 일수(인원×월 그리드)·기술지원 방문일을 전기한다. 이 값이 식대·출퇴근교통비·출장비 산출의 기준.
export default async function AttendancePage({
  searchParams,
}: {
  searchParams: Promise<{ site?: string; round?: string }>
}) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const params = await searchParams

  // 배정된 현장
  const { data: assignments } = await supabase
    .from('user_site_assignments')
    .select('site_id, sites(*)')
    .eq('user_id', user.id)
    .eq('is_active', true)

  const sites = ((assignments ?? []).map((a) => a.sites).filter(Boolean) as unknown) as Site[]
  const siteId = params.site ?? sites[0]?.id ?? ''

  if (!siteId) {
    return <div className="p-8 text-center text-sm text-gray-400">배정된 현장이 없습니다.</div>
  }

  // 기성회차 — 출근부는 회차 기성기간 단위로 전기한다 (진행 중 회차가 기본)
  const { data: roundsData } = await supabase
    .from('settlement_rounds')
    .select('*')
    .eq('site_id', siteId)
    .order('round_no')
  const rounds = (roundsData ?? []) as SettlementRound[]
  const openRound = rounds.find((r) => r.status === 'open') ?? null
  const selectedRound = rounds.find((r) => r.id === params.round) ?? openRound
  const nextRoundNo = (rounds[rounds.length - 1]?.round_no ?? 0) + 1

  const months = selectedRound ? monthsOfRound(selectedRound) : []
  const years = [...new Set(months.map((ym) => parseInt(ym.slice(0, 4), 10)))]

  // 기존 출근부(일수·방문일)·첨부(회차 기간 전체), 기술인 명부
  // 정산 인원의 원천은 기술인 명부(site_staff_members)이며, 로그인 계정은 권한용으로만 쓴다
  const [{ data: recordsData }, { data: sheetsData }, { data: membersData }] = await Promise.all([
    selectedRound
      ? supabase
          .from('attendance_records')
          .select('*')
          .eq('site_id', siteId)
          .in('year', years)
      : Promise.resolve({ data: [] as AttendanceRecord[] }),
    selectedRound
      ? supabase
          .from('attendance_sheets')
          .select('*')
          .eq('site_id', siteId)
          .in('year', years)
      : Promise.resolve({ data: [] as AttendanceSheet[] }),
    supabase
      .from('site_staff_members')
      .select('*')
      .eq('site_id', siteId)
      .eq('is_active', true)
      .order('sort_order')
      .order('created_at'),
  ])
  const inRound = (year: number, month: number) => months.includes(`${year}-${pad(month)}`)
  const records = ((recordsData ?? []) as AttendanceRecord[]).filter((r) => inRound(r.year, r.month))
  const sheets = ((sheetsData ?? []) as AttendanceSheet[]).filter((s) => inRound(s.year, s.month))
  const members = (membersData ?? []) as SiteStaffMember[]
  const membersOf = (t: StaffType) => members.filter((m) => m.staff_type === t)
  // 회차 기간 내 첨부 통합 (월별 시트에 동일 URL이 저장되므로 중복 제거)
  const sheetUrlsOf = (t: StaffType) => [
    ...new Set(sheets.filter((s) => s.staff_type === t).flatMap((s) => s.file_urls)),
  ]

  return (
    <div className="mx-auto max-w-4xl space-y-4 p-6">
      <div>
        <h1 className="text-xl font-bold text-gray-900">출근부</h1>
        <p className="text-sm text-gray-500">
          기성기간을 기재한 뒤, 현장에서 작성·서명한 출근부(기간 전체 1부)를 구분별로 첨부하고
          기재된 일수를 옮겨 입력하세요. 이 일수가 식대·출퇴근교통비·출장비 산출의 기준이 됩니다.
        </p>
      </div>

      {/* 현장·회차 선택 + 기성기간 */}
      <div className="space-y-3 rounded-xl border border-gray-200 bg-white p-4">
        {(sites.length > 1 || rounds.length > 1) && (
          <form method="get" className="flex flex-wrap gap-3">
            <div>
              <label className="mb-1 block text-xs text-gray-500">현장</label>
              <select
                name="site"
                defaultValue={siteId}
                className="rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none"
              >
                {sites.map((s) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
            </div>
            {rounds.length > 0 && (
              <div>
                <label className="mb-1 block text-xs text-gray-500">기성회차</label>
                <select
                  name="round"
                  defaultValue={selectedRound?.id}
                  className="rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none"
                >
                  {rounds.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.round_no}회차 ({r.period_start} ~ {r.period_end}{r.status === 'open' ? ', 진행 중' : ''})
                    </option>
                  ))}
                </select>
              </div>
            )}
            <div className="flex items-end">
              <button type="submit" className="rounded-lg bg-gray-100 px-3 py-2 text-sm text-gray-700 hover:bg-gray-200">
                조회
              </button>
            </div>
          </form>
        )}

        {/* 기성기간 — 진행 중 회차는 수정, 없으면 입력 즉시 다음 회차 시작 */}
        {selectedRound?.status === 'open' || !selectedRound ? (
          <RoundPeriodEditor
            siteId={siteId}
            round={
              selectedRound
                ? {
                    id: selectedRound.id,
                    round_no: selectedRound.round_no,
                    period_start: selectedRound.period_start,
                    period_end: selectedRound.period_end,
                  }
                : null
            }
            nextRoundNo={nextRoundNo}
          />
        ) : (
          <p className="text-sm text-gray-500">
            {selectedRound.round_no}회차 기성기간: {selectedRound.period_start} ~ {selectedRound.period_end}
            <span className="ml-2 rounded bg-gray-100 px-2 py-0.5 text-xs text-gray-500">확정됨 — 조회 전용</span>
          </p>
        )}
      </div>

      {selectedRound && (
        <>
          <AttendanceSheetSection
            key={`${siteId}-${selectedRound.id}-resident`}
            siteId={siteId}
            roundId={selectedRound.id}
            periodStart={selectedRound.period_start}
            periodEnd={selectedRound.period_end}
            months={months}
            staffType="resident"
            members={membersOf('resident')}
            records={records}
            sheetFileUrls={sheetUrlsOf('resident')}
          />
          <AttendanceSheetSection
            key={`${siteId}-${selectedRound.id}-support`}
            siteId={siteId}
            roundId={selectedRound.id}
            periodStart={selectedRound.period_start}
            periodEnd={selectedRound.period_end}
            months={months}
            staffType="support"
            members={membersOf('support')}
            records={records}
            sheetFileUrls={sheetUrlsOf('support')}
          />
        </>
      )}
    </div>
  )
}
