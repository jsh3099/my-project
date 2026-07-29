// 정산서 출력 데이터 준비층 — 총괄표·세부 사용내역 시트의 단일 원천
//
// 회차(roundId)가 지정되면 확정 회차의 expenses(settlement_round_id 매칭),
// 지정되지 않으면 진행 중(미편입) 지출을 잠정 집계한다.

import type { SupabaseClient } from '@supabase/supabase-js'
import { buildCategorySummaryTree, type CategoryTotal } from '@/lib/expenseSummaryTree'
import type { Expense, ExpenseItem, CommuteCalc, TripVisit, WelfareSettlement, SettlementRound, Site, CompanyProfile } from '@/types'

export interface PersonExpense extends Expense {
  items: ExpenseItem[]
  commuteCalc: CommuteCalc | null
  tripVisits: TripVisit[]
  welfare: WelfareSettlement | null
}

export interface SettlementReportData {
  site: Site
  company: CompanyProfile | null
  round: SettlementRound | null           // 대상 회차 (없으면 잠정)
  confirmedRounds: SettlementRound[]      // 확정 회차 이력 (전회기성 계산용)
  priorCumulative: number                 // 전회까지 누계 (인정금액 기준)
  priorByCategory: Map<string, number>    // 비목별 전회 누계 (확정 회차 지출 재집계)
  currentAmount: number                   // 금회 금액 (인정금액 기준)
  summaryTree: CategoryTotal[]            // 항목별 사용금액 (3번 표) — 인정금액 기준
  expenses: PersonExpense[]               // 세부 시트 원천 (자식 테이블 포함)
  periodLabel: string                     // 금회 정산기간 표기
}

/** 인정금액 (amount - over_limit_amount) */
export function recognized(e: { amount: number; over_limit_amount: number }): number {
  return e.amount - (e.over_limit_amount ?? 0)
}

export async function getSettlementReportData(
  admin: SupabaseClient,
  siteId: string,
  roundId?: string | null,
): Promise<SettlementReportData | { error: string }> {
  const { data: site } = await admin.from('sites').select('*').eq('id', siteId).single()
  if (!site) return { error: '현장을 찾을 수 없습니다.' }

  const { data: company } = await admin.from('company_profile').select('*').eq('id', true).maybeSingle()

  const { data: rounds } = await admin
    .from('settlement_rounds')
    .select('*')
    .eq('site_id', siteId)
    .order('round_no')
  const allRounds = (rounds ?? []) as SettlementRound[]
  const confirmedRounds = allRounds.filter((r) => r.status === 'confirmed')
  const round = roundId ? allRounds.find((r) => r.id === roundId) ?? null : allRounds.find((r) => r.status === 'open') ?? null

  // 대상 지출 조회
  let query = admin
    .from('expenses')
    .select('*')
    .eq('site_id', siteId)
    .is('deleted_at', null)
  if (round?.status === 'confirmed') {
    query = query.eq('settlement_round_id', round.id)
  } else {
    // 잠정: 아직 회차에 편입되지 않은 지출 (기간이 있으면 기간 필터)
    query = query.is('settlement_round_id', null).in('status', ['draft', 'submitted'])
    if (round) {
      query = query.gte('expense_date', round.period_start).lte('expense_date', round.period_end)
    }
  }
  const { data: expenseRows, error: expenseError } = await query.order('expense_date')
  if (expenseError) return { error: expenseError.message }
  const expenses = (expenseRows ?? []) as Expense[]

  // 자식 테이블 일괄 로드
  const ids = expenses.map((e) => e.id)
  const [itemsRes, commuteRes, visitsRes, welfareRes] = ids.length
    ? await Promise.all([
        admin.from('expense_items').select('*').in('expense_id', ids).order('sort_order'),
        admin.from('commute_calcs').select('*').in('expense_id', ids),
        admin.from('trip_visits').select('*').in('expense_id', ids).order('visit_date'),
        admin.from('welfare_settlements').select('*').in('expense_id', ids),
      ])
    : [{ data: [] }, { data: [] }, { data: [] }, { data: [] }]

  const itemsBy = groupBy((itemsRes.data ?? []) as ExpenseItem[], (i) => i.expense_id)
  const commuteBy = new Map(((commuteRes.data ?? []) as CommuteCalc[]).map((c) => [c.expense_id, c]))
  const visitsBy = groupBy((visitsRes.data ?? []) as TripVisit[], (v) => v.expense_id)
  const welfareBy = new Map(((welfareRes.data ?? []) as WelfareSettlement[]).map((w) => [w.expense_id, w]))

  const enriched: PersonExpense[] = expenses.map((e) => ({
    ...e,
    items: itemsBy.get(e.id) ?? [],
    commuteCalc: commuteBy.get(e.id) ?? null,
    tripVisits: visitsBy.get(e.id) ?? [],
    welfare: welfareBy.get(e.id) ?? null,
  }))

  // 인정금액 기준 집계 (F-23: 불인정분은 합계에서 제외)
  const summaryTree = buildCategorySummaryTree(
    enriched.map((e) => ({
      category: e.category,
      subcategory: e.subcategory,
      amount: recognized(e),
      amount_gross: e.amount_gross,
    })),
  )
  const currentAmount = enriched.reduce((s, e) => s + recognized(e), 0)

  // 전회 누계: 대상 회차 이전에 확정된 회차들의 스냅샷 합
  const priorRounds = round
    ? confirmedRounds.filter((r) => r.round_no < round.round_no)
    : confirmedRounds
  const priorCumulative = priorRounds.reduce((s, r) => Math.max(s, r.prior_cumulative_amount + r.current_round_amount), 0)

  // 비목별 전회 누계: 확정 회차에 편입된 지출을 재집계 (정산서 2번 표 전회기성금액 열)
  const priorByCategory = new Map<string, number>()
  if (priorRounds.length > 0) {
    const { data: priorExpenses } = await admin
      .from('expenses')
      .select('category, amount, over_limit_amount')
      .in('settlement_round_id', priorRounds.map((r) => r.id))
      .is('deleted_at', null)
    for (const e of (priorExpenses ?? []) as { category: string; amount: number; over_limit_amount: number }[]) {
      priorByCategory.set(e.category, (priorByCategory.get(e.category) ?? 0) + recognized(e))
    }
  }

  const periodLabel = round
    ? `${round.period_start.replaceAll('-', '.')}~${round.period_end.replaceAll('-', '.')}`
    : '미확정 (잠정)'

  return {
    site: site as Site,
    company: (company as CompanyProfile) ?? null,
    round,
    confirmedRounds,
    priorCumulative,
    priorByCategory,
    currentAmount,
    summaryTree,
    expenses: enriched,
    periodLabel,
  }
}

function groupBy<T>(arr: T[], key: (t: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>()
  for (const item of arr) {
    const k = key(item)
    m.set(k, [...(m.get(k) ?? []), item])
  }
  return m
}
