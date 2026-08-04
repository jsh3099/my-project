import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { StaffCostForm } from '@/components/expenses/StaffCostForm'
import { SupportTripForm } from '@/components/expenses/SupportTripForm'
import type { StaffType } from '@/lib/constants'
import { STAFF_TYPE_LABELS } from '@/lib/constants'
import type { Site, Profile, AttendanceRecord, SiteStaffMember } from '@/types'

function currentYearMonth() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

export async function StaffCostsPageContent({
  staffType,
  searchParams,
}: {
  staffType: StaffType
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
    .select('site_id, sites(id, name, address)')
    .eq('user_id', user.id)
    .eq('is_active', true)

  const sites = ((assignments ?? []).map((a) => a.sites).filter(Boolean) as unknown) as Site[]
  const siteId = params.site ?? sites[0]?.id ?? ''
  const site = sites.find((s) => s.id === siteId)
  const siteName = site?.name ?? ''

  if (!siteId) {
    return (
      <div className="p-8 text-center text-sm text-gray-400">배정된 현장이 없습니다.</div>
    )
  }

  // 정산 인원의 원천은 기술인 명부(site_staff_members) — 로그인 계정은 권한용으로만 쓴다
  const admin = createAdminClient()

  // 출근부 데이터 + 현장 기술인 명부
  const [{ data: attendanceData }, { data: membersData }] = await Promise.all([
    supabase
      .from('attendance_records')
      .select('*')
      .eq('site_id', siteId)
      .eq('year', parseInt(year, 10))
      .eq('month', month),
    supabase
      .from('site_staff_members')
      .select('*')
      .eq('site_id', siteId)
      .eq('staff_type', staffType)
      .eq('is_active', true)
      .order('sort_order')
      .order('created_at'),
  ])

  const attendance = (attendanceData ?? []) as AttendanceRecord[]
  const members = (membersData ?? []) as SiteStaffMember[]

  // 자차 산출 기본값(자택주소·유종)용 본인 프로필
  const { data: meData } = await admin.from('profiles').select('*').eq('id', user.id).maybeSingle()
  const me = (meData as Profile) ?? null

  // 현장별 정산 파라미터 (식대 한도·여비규정 적용 여부)
  const { data: siteParams } = await admin
    .from('site_parameters')
    .select('meal_allowance_daily_limit, apply_commute_regulation, commute_trips_per_month, trip_daily_allowance, trip_meal_allowance')
    .eq('site_id', siteId)
    .maybeSingle()

  // 기술지원 기술인은 주재비가 아닌 출장비(방문일별 산출)로 정산한다 — 정산서 2-1
  const isSupport = staffType === 'support'

  return (
    <div className="mx-auto max-w-5xl space-y-4 p-6">
      <div className="flex items-center gap-2">
        <h1 className="text-xl font-bold text-gray-900">
          {STAFF_TYPE_LABELS[staffType]} {isSupport ? '출장비' : '주재비'} 입력
        </h1>
        <span className="rounded bg-gray-100 px-2 py-0.5 text-xs text-gray-500">{isSupport ? '정산서 2-1' : '정산서 3.1'}</span>
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

      {isSupport ? (
        <SupportTripForm
          siteId={siteId}
          siteName={siteName}
          yearMonth={yearMonth}
          members={members}
          attendance={attendance}
          siteAddress={site?.address}
          tripDailyAllowance={siteParams?.trip_daily_allowance ?? 25000}
          tripMealAllowance={siteParams?.trip_meal_allowance ?? 25000}
        />
      ) : (
        <StaffCostForm
          siteId={siteId}
          siteName={siteName}
          yearMonth={yearMonth}
          members={members}
          attendance={attendance}
          mealDailyLimit={siteParams?.meal_allowance_daily_limit ?? 25000}
          applyCommuteRegulation={siteParams?.apply_commute_regulation ?? true}
          commuteTripsDefault={siteParams?.commute_trips_per_month ?? 4}
          siteAddress={site?.address}
          myUserId={user.id}
          myHomeAddress={me?.home_address}
          myFuelType={me?.vehicle_fuel_type}
        />
      )}
    </div>
  )
}
