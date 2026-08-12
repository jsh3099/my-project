import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import { PlusCircle } from 'lucide-react'
import { ExpenseList } from '@/components/expenses/ExpenseList'
import { SiteSelect, MonthSelect } from '@/components/expenses/ExpenseFilters'
import type { Expense, SettlementRound, Site } from '@/types'

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
    if (m > 12) { m = 1; y += 1 }
  }
  return months
}

export default async function ExpensesPage({
  searchParams,
}: {
  searchParams: Promise<{ month?: string; site?: string }>
}) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const params = await searchParams
  const ym = params.month ?? currentYearMonth()

  const { data: assignments } = await supabase
    .from('user_site_assignments')
    .select('site_id, sites(id, name)')
    .eq('user_id', user.id)
    .eq('is_active', true)

  const sites = (assignments?.map((a) => a.sites).filter(Boolean) ?? []) as unknown as Site[]
  const selectedSiteId = params.site ?? sites[0]?.id ?? ''

  let expenses: Expense[] = []
  // 제출은 회차 단위 — 진행 중 회차의 작성중 항목 현황(조회 월과 무관)을 함께 집계한다
  let round: { label: string; draftCount: number; draftAmount: number } | null = null
  if (selectedSiteId) {
    const [{ data }, { data: openRoundData }] = await Promise.all([
      supabase
        .from('expenses')
        .select('*')
        .eq('site_id', selectedSiteId)
        .eq('user_id', user.id)
        .eq('year_month', ym)
        .is('deleted_at', null)
        .order('expense_date', { ascending: false }),
      supabase
        .from('settlement_rounds')
        .select('*')
        .eq('site_id', selectedSiteId)
        .eq('status', 'open')
        .maybeSingle(),
    ])
    expenses = (data ?? []) as Expense[]

    const openRound = (openRoundData ?? null) as SettlementRound | null
    if (openRound) {
      const { data: draftRows } = await supabase
        .from('expenses')
        .select('amount, over_limit_amount')
        .eq('site_id', selectedSiteId)
        .eq('user_id', user.id)
        .eq('status', 'draft')
        .is('deleted_at', null)
        .in('year_month', monthsOfRound(openRound))
      const drafts = draftRows ?? []
      round = {
        label: `${openRound.round_no}회차 (${openRound.period_start} ~ ${openRound.period_end})`,
        draftCount: drafts.length,
        draftAmount: drafts.reduce((s, e) => s + (e.amount - (e.over_limit_amount ?? 0)), 0),
      }
    }
  }

  const totalAmount = expenses.reduce((s, e) => s + e.amount, 0)
  const approvedAmount = expenses
    .filter((e) => e.status === 'approved')
    .reduce((s, e) => s + e.amount, 0)

  // 제출 가능한지 (draft 항목이 1개 이상 있어야)
  const hasDraft = expenses.some((e) => e.status === 'draft')
  const allSubmitted = expenses.length > 0 && !hasDraft

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-gray-900">입력 내역 · 본사 제출</h1>
          <p className="mt-1 text-sm text-gray-500">
            입력한 직접경비를 월별로 확인하고, 진행 중 기성회차 전체를 한 번에 본사로 제출합니다.
          </p>
        </div>
        <Link
          href="/expenses/new"
          className="flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700"
        >
          <PlusCircle className="h-4 w-4" />
          비용 입력
        </Link>
      </div>

      {/* 필터: 현장 + 월 */}
      <div className="flex flex-wrap gap-3 rounded-xl border border-gray-200 bg-white p-4">
        {sites.length > 1 && (
          <div>
            <label className="mb-1 block text-xs text-gray-500">현장</label>
            <SiteSelect sites={sites} selectedSiteId={selectedSiteId} ym={ym} />
          </div>
        )}
        <div>
          <label className="mb-1 block text-xs text-gray-500">월</label>
          <MonthSelect ym={ym} siteId={selectedSiteId} />
        </div>
      </div>

      {/* 요약 */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
        <div className="rounded-xl border border-gray-200 bg-white p-4">
          <p className="text-xs text-gray-500">이 달 입력액</p>
          <p className="mt-1 text-lg font-bold text-gray-900">{totalAmount.toLocaleString()}원</p>
          <p className="text-xs text-gray-400">{expenses.length}건</p>
        </div>
        <div className="rounded-xl border border-green-200 bg-green-50 p-4">
          <p className="text-xs text-gray-500">승인 금액</p>
          <p className="mt-1 text-lg font-bold text-green-700">{approvedAmount.toLocaleString()}원</p>
          <p className="text-xs text-gray-400">{expenses.filter((e) => e.status === 'approved').length}건</p>
        </div>
        <div className={`rounded-xl border p-4 ${allSubmitted ? 'border-yellow-200 bg-yellow-50' : 'border-gray-200 bg-white'}`}>
          <p className="text-xs text-gray-500">상태</p>
          <p className={`mt-1 text-lg font-bold ${allSubmitted ? 'text-yellow-600' : 'text-gray-700'}`}>
            {allSubmitted ? '검토중' : hasDraft ? '작성중' : '없음'}
          </p>
        </div>
      </div>

      <ExpenseList
        expenses={expenses}
        siteId={selectedSiteId}
        yearMonth={ym}
        hasDraft={hasDraft}
        round={round}
      />
    </div>
  )
}

