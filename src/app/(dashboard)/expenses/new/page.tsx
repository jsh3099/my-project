import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { redirect } from 'next/navigation'
import { SiteExpenseBoard, type SiteExpenseCardDraft } from '@/components/expenses/SiteExpenseBoard'
import { getSiteBudgetStatus } from '@/lib/budgetStatus'
import { EXPENSE_SUBCATEGORIES, type ExpenseCategory } from '@/lib/constants'
import type { Site, Profile, SettlementRound } from '@/types'

const pad = (n: number) => String(n).padStart(2, '0')

function currentYearMonth() {
  const d = new Date()
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`
}

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
    if (m > 12) { m = 1; y += 1 }
  }
  return months
}

// 이 화면이 다루는 세부항목 — 수기 입력(manual_site·manual_person)만.
// 자동산출·인원별 recurring 항목은 주재비·출장비 화면 담당 (중복 입력 방지)
const MANUAL_SUBS = Object.entries(EXPENSE_SUBCATEGORIES).flatMap(([, subs]) =>
  subs.filter((s) => s.entryType === 'manual_site' || s.entryType === 'manual_person').map((s) => s.value),
)

export default async function NewExpensePage({
  searchParams,
}: {
  searchParams: Promise<{ site?: string }>
}) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const params = await searchParams

  const { data: assignments } = await supabase
    .from('user_site_assignments')
    .select('site_id, sites(id, name, direct_expense_budget, status)')
    .eq('user_id', user.id)
    .eq('is_active', true)

  const sites = (assignments?.map((a) => a.sites).filter(Boolean) ?? []) as unknown as Site[]
  const siteId = params.site ?? sites[0]?.id ?? ''

  if (!siteId) {
    return (
      <div className="mx-auto max-w-4xl space-y-6 p-6">
        <h1 className="text-xl font-bold text-gray-900">현장경비 입력</h1>
        <div className="rounded-xl border border-yellow-200 bg-yellow-50 p-6 text-center">
          <p className="font-medium text-yellow-800">배정된 현장이 없습니다</p>
          <p className="mt-1 text-sm text-yellow-600">시스템 관리자에게 현장 배정을 요청하세요.</p>
        </div>
      </div>
    )
  }

  const admin = createAdminClient()

  // 진행 중 기성회차 — 카드가 회차 기성기간 전체를 다룬다 (없으면 이번 달만)
  const { data: openRoundData } = await supabase
    .from('settlement_rounds')
    .select('*')
    .eq('site_id', siteId)
    .eq('status', 'open')
    .maybeSingle()
  const openRound = (openRoundData ?? null) as SettlementRound | null
  const months = openRound ? monthsOfRound(openRound) : [currentYearMonth()]
  const periodStart = openRound?.period_start ?? `${months[0]}-01`
  const periodEnd = openRound?.period_end ?? `${months[0]}-31`
  const roundLabel = openRound
    ? `${openRound.round_no}회차 (진행 중 · ${openRound.period_start} ~ ${openRound.period_end})`
    : `${months[0]} (진행 중 회차 없음 — 이번 달 기준)`

  // 현장 파라미터 (복리후생 월한도)
  const { data: siteParams } = await admin
    .from('site_parameters')
    .select('welfare_monthly_limit')
    .eq('site_id', siteId)
    .maybeSingle()

  // manual_person 대상자 옵션 (현장 배정 계정)
  const { data: assignmentsData } = await admin
    .from('user_site_assignments')
    .select('user_id')
    .eq('site_id', siteId)
    .eq('is_active', true)
  const userIds = [...new Set((assignmentsData ?? []).map((a) => a.user_id))]
  let staff: Profile[] = []
  if (userIds.length > 0) {
    const { data: profilesData } = await admin
      .from('profiles')
      .select('*')
      .in('id', userIds)
      .eq('is_active', true)
    staff = (profilesData ?? []) as Profile[]
  }

  // 계상 잔액 (카드 캡션·시트)
  const budgetBySite = await getSiteBudgetStatus(supabase, admin, sites.filter((s) => s.id === siteId))

  // 회차 기간의 draft 복원 — 카드에 내역·첨부가 그대로 살아난다
  const { data: draftData } = await admin
    .from('expenses')
    .select('category, subcategory, target_user_id, year_month, vat_mode, headcount, receipt_urls, expense_items(item_date, vendor, description, tag, amount_gross, sort_order)')
    .eq('site_id', siteId)
    .eq('status', 'draft')
    .in('year_month', months)
    .in('subcategory', MANUAL_SUBS)
    .is('deleted_at', null)

  type DraftRaw = {
    category: ExpenseCategory
    subcategory: string
    target_user_id: string | null
    year_month: string
    vat_mode: 'none' | 'exclude_10' | null
    headcount: number
    receipt_urls: string[] | null
    expense_items: { item_date: string; vendor: string | null; description: string | null; tag: string | null; amount_gross: number; sort_order: number }[] | null
  }
  const drafts: SiteExpenseCardDraft[] = ((draftData ?? []) as unknown as DraftRaw[]).map((d) => ({
    category: d.category,
    subcategory: d.subcategory,
    targetUserId: d.target_user_id,
    yearMonth: d.year_month,
    vatMode: d.vat_mode === 'exclude_10' ? 'exclude_10' : 'none',
    headcount: d.headcount,
    receiptUrls: d.receipt_urls ?? [],
    items: [...(d.expense_items ?? [])]
      .sort((a, b) => a.sort_order - b.sort_order)
      .map((i) => ({
        date: i.item_date,
        vendor: i.vendor ?? '',
        description: i.description ?? '',
        tag: i.tag ?? '',
        amountGross: i.amount_gross,
      })),
  }))

  return (
    <div className="mx-auto max-w-5xl space-y-4 p-6">
      <div className="flex items-center gap-2">
        <h1 className="text-xl font-bold text-gray-900">현장경비 입력</h1>
        <span className="rounded bg-gray-100 px-2 py-0.5 text-xs text-gray-500">정산서 세부 사용내역</span>
      </div>

      {/* 현장 선택 (여러 현장 배정 시) */}
      {sites.length > 1 && (
        <form method="get" className="flex flex-wrap gap-3 rounded-xl border border-gray-200 bg-white p-4">
          <div>
            <label className="mb-1 block text-xs text-gray-500">현장</label>
            <select name="site" defaultValue={siteId}
              className="rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none">
              {sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </div>
          <div className="flex items-end">
            <button type="submit" className="rounded-lg bg-gray-100 px-3 py-2 text-sm text-gray-700 hover:bg-gray-200">
              조회
            </button>
          </div>
        </form>
      )}

      <SiteExpenseBoard
        key={`${siteId}-${openRound?.id ?? months[0]}`}
        siteId={siteId}
        roundLabel={roundLabel}
        months={months}
        periodStart={periodStart}
        periodEnd={periodEnd}
        staff={staff}
        welfareLimit={siteParams?.welfare_monthly_limit ?? 50000}
        budget={budgetBySite[siteId] ?? null}
        drafts={drafts}
      />
    </div>
  )
}
