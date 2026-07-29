// 정산서 출력 데이터 준비층 — 총괄표·세부 사용내역 시트의 단일 원천
//
// 회차(roundId)가 지정되면 확정 회차의 expenses(settlement_round_id 매칭),
// 지정되지 않으면 진행 중(미편입) 지출을 잠정 집계한다.

import type { SupabaseClient } from '@supabase/supabase-js'
import { buildCategorySummaryTree, type CategoryTotal } from '@/lib/expenseSummaryTree'
import { calcClaim, type ClaimItemResult } from '@/lib/settlement'
import { EXPENSE_CATEGORY_LABELS, type ExpenseCategory } from '@/lib/constants'
import type { Expense, ExpenseItem, CommuteCalc, TripVisit, WelfareSettlement, SettlementRound, SettlementRoundItem, Site, CompanyProfile } from '@/types'

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
  priorCumulative: number                 // 전회까지 누계 청구(기성)액
  currentAmount: number                   // 금회 사용액 (인정금액 기준)
  claimItems: ClaimItemResult[]           // 항목별 계약금액/전회누계/금회기성/잔액 (2번 표 원천)
  claimTotal: number                      // 금회 청구(기성)액 = min(사용액, 계상총액 잔액)
  unpaidAmount: number                    // 잔액 초과 사용분 (청구 불가)
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

  // 전회 누계 청구액: 대상 회차 이전에 확정된 회차들의 청구액 합
  const priorRounds = round
    ? confirmedRounds.filter((r) => r.round_no < round.round_no)
    : confirmedRounds
  const priorCumulative = priorRounds.reduce((s, r) => s + r.claim_amount, 0)

  // 2번 표 (항목별 계약금액/전회누계/금회기성/잔액):
  //  · 확정 회차 → 확정 시점 스냅샷(settlement_round_items)을 그대로 사용
  //  · 잠정      → 계상금액·전회 스냅샷·금회 사용액으로 청구액을 계산
  let claimItems: ClaimItemResult[]
  let claimTotal: number
  let unpaidAmount: number
  if (round?.status === 'confirmed') {
    const { data: itemRows } = await admin
      .from('settlement_round_items')
      .select('*')
      .eq('round_id', round.id)
    claimItems = ((itemRows ?? []) as SettlementRoundItem[]).map((i) => ({
      category: i.category,
      contractAmount: i.contract_amount,
      priorCumulative: i.prior_cumulative,
      usedAmount: i.used_amount,
      claimAmount: i.claim_amount,
      remaining: i.contract_amount - i.prior_cumulative - i.claim_amount,
    }))
    claimTotal = round.claim_amount
    unpaidAmount = round.current_round_amount - round.claim_amount
  } else {
    const [{ data: budgetRows }, { data: priorItemRows }] = await Promise.all([
      admin.from('site_expense_budgets').select('category, amount').eq('site_id', siteId),
      priorRounds.length > 0
        ? admin
            .from('settlement_round_items')
            .select('category, claim_amount')
            .in('round_id', priorRounds.map((r) => r.id))
        : Promise.resolve({ data: [] as Pick<SettlementRoundItem, 'category' | 'claim_amount'>[] }),
    ])
    const budgetByCategory = new Map((budgetRows ?? []).map((b) => [b.category as string, b.amount as number]))
    const priorByCategory = new Map<string, number>()
    for (const row of (priorItemRows ?? []) as Pick<SettlementRoundItem, 'category' | 'claim_amount'>[]) {
      priorByCategory.set(row.category, (priorByCategory.get(row.category) ?? 0) + row.claim_amount)
    }
    const usedByCategory = new Map<string, number>()
    for (const e of expenses) {
      usedByCategory.set(e.category, (usedByCategory.get(e.category) ?? 0) + recognized(e))
    }
    const result = calcClaim({
      totalBudget: (site as Site).direct_expense_budget,
      priorClaimTotal: priorCumulative,
      items: (Object.keys(EXPENSE_CATEGORY_LABELS) as ExpenseCategory[]).map((category) => ({
        category,
        contractAmount: budgetByCategory.get(category) ?? 0,
        priorCumulative: priorByCategory.get(category) ?? 0,
        usedAmount: usedByCategory.get(category) ?? 0,
      })),
    })
    claimItems = result.items
    claimTotal = result.claimTotal
    unpaidAmount = result.unpaidAmount
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
    currentAmount,
    claimItems,
    claimTotal,
    unpaidAmount,
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
