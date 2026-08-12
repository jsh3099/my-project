import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { StaffCostForm, type StaffCostDraftItem } from '@/components/expenses/StaffCostForm'
import { SupportTripForm } from '@/components/expenses/SupportTripForm'
import { getSiteBudgetStatus } from '@/lib/budgetStatus'
import type { StaffType, CommuteMode, VehicleFuelType } from '@/lib/constants'
import { STAFF_TYPE_LABELS } from '@/lib/constants'
import type { Site, Profile, AttendanceRecord, SiteStaffMember, SettlementRound, LodgingCalcDetail } from '@/types'

function currentYearMonth() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

const pad = (n: number) => String(n).padStart(2, '0')

// 회차 기성기간에 걸치는 연월 목록 (최대 24개월 안전 상한)
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
    .select('site_id, sites(id, name, address, direct_expense_budget)')
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

  // 진행 중 기성회차 — 출근부가 회차 단위(합계 일수·기간 전체 방문일)로 전기되므로
  // 주재비·출장비 폼의 프리필도 회차 기준으로 집계한다
  const { data: openRoundData } = await supabase
    .from('settlement_rounds')
    .select('*')
    .eq('site_id', siteId)
    .eq('status', 'open')
    .maybeSingle()
  const openRound = (openRoundData ?? null) as SettlementRound | null
  const roundMonths = openRound ? monthsOfRound(openRound) : []
  const roundYears = [...new Set(roundMonths.map((ym) => parseInt(ym.slice(0, 4), 10)))]

  // 출근부 데이터 + 현장 기술인 명부
  const [{ data: attendanceData }, { data: membersData }] = await Promise.all([
    openRound
      ? supabase
          .from('attendance_records')
          .select('*')
          .eq('site_id', siteId)
          .in('year', roundYears)
      : supabase
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

  // 회차 기준이면 인원별로 합산(출근일수 합계는 시작 월 레코드에 있고, 방문일은 월별로 흩어져 있다)
  let attendance = (attendanceData ?? []) as AttendanceRecord[]
  if (openRound) {
    const inRound = attendance.filter((r) => roundMonths.includes(`${r.year}-${pad(r.month)}`))
    const byPerson = new Map<string, AttendanceRecord>()
    for (const r of inRound) {
      const key = r.user_id ?? `m_${r.member_id}`
      const acc = byPerson.get(key)
      if (!acc) {
        byPerson.set(key, { ...r, visit_dates: r.visit_dates ? [...r.visit_dates] : null })
      } else {
        acc.work_days += r.work_days
        if (r.visit_dates?.length) {
          acc.visit_dates = [...(acc.visit_dates ?? []), ...r.visit_dates].sort()
        }
      }
    }
    attendance = [...byPerson.values()]
  }
  const members = (membersData ?? []) as SiteStaffMember[]

  // 이미 저장한 draft 주재비 — 영수증을 올릴 때마다 저장해 나가는 흐름이라
  // 재진입 시 금액·건별 내역·첨부가 폼에 그대로 복원되어야 한다.
  // (복원하지 않으면 빈 폼으로 「임시저장」했을 때 기존 draft가 지워진다)
  const { data: draftData } = await admin
    .from('expenses')
    .select('subcategory, target_user_id, target_user_name, amount, period_start, period_end, receipt_urls, calc_detail, expense_items(item_date, tag, amount_gross, sort_order), commute_calcs(mode, home_address, distance_oneway_km, fuel_type, fuel_efficiency, fuel_price, fuel_price_date, toll_roundtrip, multiplier)')
    .eq('site_id', siteId)
    .eq('year', parseInt(year, 10))
    .eq('month', month)
    .eq('status', 'draft')
    .eq('category', 'site_residence')
    .not('target_user_name', 'is', null)
    .is('deleted_at', null)

  type DraftRaw = {
    subcategory: string
    target_user_id: string | null
    target_user_name: string
    amount: number
    period_start: string | null
    period_end: string | null
    receipt_urls: string[] | null
    calc_detail: LodgingCalcDetail | null
    expense_items: { item_date: string; tag: string | null; amount_gross: number; sort_order: number }[] | null
    commute_calcs: {
      mode: CommuteMode; home_address: string | null; distance_oneway_km: number
      fuel_type: VehicleFuelType; fuel_efficiency: number; fuel_price: number
      fuel_price_date: string | null; toll_roundtrip: number; multiplier: number
    }[] | null
  }
  const existingDrafts: StaffCostDraftItem[] = ((draftData ?? []) as unknown as DraftRaw[]).map((d) => {
    const commute = d.commute_calcs?.[0] ?? null
    return {
      identity: d.target_user_name,
      subcategory: d.subcategory,
      amount: d.amount,
      periodStart: d.period_start,
      periodEnd: d.period_end,
      receiptUrls: d.receipt_urls ?? [],
      calcDetail: d.calc_detail,
      maintItems: [...(d.expense_items ?? [])]
        .sort((a, b) => a.sort_order - b.sort_order)
        .map((i) => ({ date: i.item_date, tag: i.tag ?? '전기', amountGross: i.amount_gross })),
      commute: commute
        ? {
            mode: commute.mode,
            homeAddress: commute.home_address,
            distanceOnewayKm: commute.distance_oneway_km,
            fuelType: commute.fuel_type,
            fuelEfficiency: commute.fuel_efficiency,
            fuelPrice: commute.fuel_price,
            fuelPriceDate: commute.fuel_price_date,
            tollRoundtrip: commute.toll_roundtrip,
            multiplier: commute.multiplier,
          }
        : null,
    }
  })

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

  // 비목 계상 잔액 — 발주청 정산(매 기성·준공)은 증빙으로 채운 만큼만 지급되므로
  // 입력 화면에서 삭감 위험을 먼저 보이게 한다 (used에는 draft 포함, 현장 전체 기준)
  const budgetBySite = site ? await getSiteBudgetStatus(supabase, admin, [site]) : {}
  const budgetCat = budgetBySite[siteId]?.byCategory[isSupport ? 'business_trip' : 'site_residence']
  const categoryRemaining = budgetCat && budgetCat.budget > 0 ? budgetCat.budget - budgetCat.used : null

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
          categoryRemaining={categoryRemaining}
        />
      ) : (
        <StaffCostForm
          siteId={siteId}
          siteName={siteName}
          yearMonth={yearMonth}
          members={members}
          attendance={attendance}
          existingDrafts={existingDrafts}
          defaultPeriodStart={openRound?.period_start}
          defaultPeriodEnd={openRound?.period_end}
          mealDailyLimit={siteParams?.meal_allowance_daily_limit ?? 25000}
          applyCommuteRegulation={siteParams?.apply_commute_regulation ?? true}
          commuteTripsDefault={siteParams?.commute_trips_per_month ?? 4}
          siteAddress={site?.address}
          myUserId={user.id}
          myHomeAddress={me?.home_address}
          myFuelType={me?.vehicle_fuel_type}
          categoryRemaining={categoryRemaining}
        />
      )}
    </div>
  )
}
