import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { StaffCostForm } from '@/components/expenses/StaffCostForm'
import type { Site, Profile, AttendanceRecord } from '@/types'

function currentYearMonth() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

export default async function StaffCostsPage({
  searchParams,
}: {
  searchParams: Promise<{ ym?: string; site?: string }>
}) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const params = await searchParams
  const yearMonth = params.ym ?? currentYearMonth()
  const [year, monthStr] = yearMonth.split('-')
  const month = parseInt(monthStr, 10)

  // 배정된 현장
  const { data: assignments } = await supabase
    .from('user_site_assignments')
    .select('site_id, sites(id, name)')
    .eq('user_id', user.id)
    .eq('is_active', true)

  const sites = ((assignments ?? []).map((a) => a.sites).filter(Boolean) as unknown) as Site[]
  const siteId = params.site ?? sites[0]?.id ?? ''
  const siteName = sites.find((s) => s.id === siteId)?.name ?? ''

  if (!siteId) {
    return (
      <div className="p-8 text-center text-sm text-gray-400">배정된 현장이 없습니다.</div>
    )
  }

  // 현장 직원 목록 (admin client로 RLS 우회)
  const admin = createAdminClient()
  const { data: siteAssignments } = await admin
    .from('user_site_assignments')
    .select('user_id')
    .eq('site_id', siteId)
    .eq('is_active', true)

  const userIds = (siteAssignments ?? []).map((a) => a.user_id)
  const staffUsers: Profile[] = []
  if (userIds.length > 0) {
    const { data: profilesData } = await admin
      .from('profiles')
      .select('*')
      .in('id', userIds)
      .eq('is_active', true)
      .order('full_name')
    if (profilesData) staffUsers.push(...(profilesData as Profile[]))
  }

  // 출근부 데이터
  const { data: attendanceData } = await supabase
    .from('attendance_records')
    .select('*')
    .eq('site_id', siteId)
    .eq('year', parseInt(year, 10))
    .eq('month', month)

  const attendance = (attendanceData ?? []) as AttendanceRecord[]

  // 현장별 정산 파라미터 (식대 한도·여비규정 적용 여부)
  const { data: siteParams } = await admin
    .from('site_parameters')
    .select('meal_allowance_daily_limit, apply_commute_regulation')
    .eq('site_id', siteId)
    .maybeSingle()

  return (
    <div className="mx-auto max-w-5xl space-y-4 p-6">
      <div className="flex items-center gap-2">
        <h1 className="text-xl font-bold text-gray-900">인원별 주재비 입력</h1>
        <span className="rounded bg-gray-100 px-2 py-0.5 text-xs text-gray-500">정산서 3.1</span>
      </div>

      {/* 현장 선택 (여러 현장 배정 시) */}
      {sites.length > 1 && (
        <form method="get" className="flex flex-wrap gap-3 rounded-xl border border-gray-200 bg-white p-4">
          <input type="hidden" name="ym" value={yearMonth} />
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
          <div className="flex items-end">
            <button type="submit" className="rounded-lg bg-gray-100 px-3 py-2 text-sm text-gray-700 hover:bg-gray-200">
              조회
            </button>
          </div>
        </form>
      )}

      <StaffCostForm
        siteId={siteId}
        siteName={siteName}
        yearMonth={yearMonth}
        users={staffUsers}
        attendance={attendance}
        mealDailyLimit={siteParams?.meal_allowance_daily_limit ?? 25000}
        applyCommuteRegulation={siteParams?.apply_commute_regulation ?? true}
      />
    </div>
  )
}
