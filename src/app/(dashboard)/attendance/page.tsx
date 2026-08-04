import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { AttendanceSheetSection } from '@/components/attendance/AttendanceSheetSection'
import type { StaffType } from '@/lib/constants'
import type { Site, AttendanceRecord, AttendanceSheet, SiteStaffMember } from '@/types'

function currentYearMonth() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

// 출근부: 현장이 실제 근무일을 작성·서명한 출근부를 상주/기술지원 구분으로 첨부하고,
// 그 일수(상주)·방문일(기술지원)을 전기한다. 이 값이 식대·출퇴근교통비·출장비 산출의 기준.
export default async function AttendancePage({
  searchParams,
}: {
  searchParams: Promise<{ ym?: string; site?: string }>
}) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const params = await searchParams
  const yearMonth = params.ym ?? currentYearMonth()
  const [yearStr, monthStr] = yearMonth.split('-')
  const year = parseInt(yearStr, 10)
  const month = parseInt(monthStr, 10)

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

  // 기존 출근부(일수·방문일), 첨부, 기술인 명부
  // 정산 인원의 원천은 기술인 명부(site_staff_members)이며, 로그인 계정은 권한용으로만 쓴다
  const [{ data: recordsData }, { data: sheetsData }, { data: membersData }] = await Promise.all([
    supabase
      .from('attendance_records')
      .select('*')
      .eq('site_id', siteId)
      .eq('year', year)
      .eq('month', month),
    supabase
      .from('attendance_sheets')
      .select('*')
      .eq('site_id', siteId)
      .eq('year', year)
      .eq('month', month),
    supabase
      .from('site_staff_members')
      .select('*')
      .eq('site_id', siteId)
      .eq('is_active', true)
      .order('sort_order')
      .order('created_at'),
  ])
  const records = (recordsData ?? []) as AttendanceRecord[]
  const sheets = (sheetsData ?? []) as AttendanceSheet[]
  const members = (membersData ?? []) as SiteStaffMember[]
  const sheetOf = (t: StaffType) => sheets.find((s) => s.staff_type === t) ?? null
  const membersOf = (t: StaffType) => members.filter((m) => m.staff_type === t)

  return (
    <div className="mx-auto max-w-4xl space-y-4 p-6">
      <div>
        <h1 className="text-xl font-bold text-gray-900">출근부</h1>
        <p className="text-sm text-gray-500">
          현장에서 작성·서명한 출근부를 구분별로 첨부하고, 기재된 일수를 그대로 옮겨 입력하세요.
          이 일수가 식대·출퇴근교통비·출장비 산출의 기준이 됩니다.
        </p>
      </div>

      {/* 현장·연월 선택 */}
      <form method="get" className="flex flex-wrap gap-3 rounded-xl border border-gray-200 bg-white p-4">
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
        <div>
          <label className="mb-1 block text-xs text-gray-500">연월</label>
          <input
            type="month"
            name="ym"
            defaultValue={yearMonth}
            className="rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none"
          />
        </div>
        <div className="flex items-end">
          <button type="submit" className="rounded-lg bg-gray-100 px-3 py-2 text-sm text-gray-700 hover:bg-gray-200">
            조회
          </button>
        </div>
      </form>

      <AttendanceSheetSection
        siteId={siteId}
        year={year}
        month={month}
        staffType="resident"
        members={membersOf('resident')}
        records={records}
        sheet={sheetOf('resident')}
      />
      <AttendanceSheetSection
        siteId={siteId}
        year={year}
        month={month}
        staffType="support"
        members={membersOf('support')}
        records={records}
        sheet={sheetOf('support')}
      />
    </div>
  )
}
