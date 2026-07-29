// 현장별 항목별 계상 잔액 집계 (서버 전용)
//
// 누계 사용 = 확정 회차 청구액 스냅샷(settlement_round_items)
//          + 아직 회차에 편입되지 않은 인정액(임시저장·제출 포함, 현장 전체).
// 삭감은 현장 단위로 발생하므로 본인 입력분이 아닌 현장 전체 기준으로 집계한다.

import type { SupabaseClient } from '@supabase/supabase-js'
import type { SettlementRoundItem } from '@/types'

export interface SiteBudgetStatus {
  totalBudget: number   // 직접경비 계상총액
  totalUsed: number     // 누계 사용 (확정 청구 + 미편입 인정액)
  byCategory: Record<string, { budget: number; used: number }>
}

export async function getSiteBudgetStatus(
  userClient: SupabaseClient,
  adminClient: SupabaseClient,
  sites: { id: string; direct_expense_budget: number }[],
): Promise<Record<string, SiteBudgetStatus>> {
  const siteIds = sites.map((s) => s.id)
  const result: Record<string, SiteBudgetStatus> = {}
  for (const s of sites) {
    result[s.id] = { totalBudget: s.direct_expense_budget ?? 0, totalUsed: 0, byCategory: {} }
  }
  if (siteIds.length === 0) return result

  const [{ data: budgetRows }, { data: confirmedRounds }, { data: ongoingRows }] = await Promise.all([
    userClient.from('site_expense_budgets').select('site_id, category, amount').in('site_id', siteIds),
    userClient.from('settlement_rounds').select('id, site_id').in('site_id', siteIds).eq('status', 'confirmed'),
    adminClient
      .from('expenses')
      .select('site_id, category, amount, over_limit_amount')
      .in('site_id', siteIds)
      .is('settlement_round_id', null)
      .in('status', ['draft', 'submitted'])
      .is('deleted_at', null),
  ])

  for (const b of budgetRows ?? []) {
    const entry = result[b.site_id]
    if (!entry) continue
    entry.byCategory[b.category] = { budget: (entry.byCategory[b.category]?.budget ?? 0) + b.amount, used: entry.byCategory[b.category]?.used ?? 0 }
  }

  const roundToSite = new Map((confirmedRounds ?? []).map((r) => [r.id as string, r.site_id as string]))
  if (roundToSite.size > 0) {
    const { data: itemRows } = await userClient
      .from('settlement_round_items')
      .select('round_id, category, claim_amount')
      .in('round_id', [...roundToSite.keys()])
    for (const row of (itemRows ?? []) as Pick<SettlementRoundItem, 'round_id' | 'category' | 'claim_amount'>[]) {
      const siteId = roundToSite.get(row.round_id)
      const entry = siteId ? result[siteId] : undefined
      if (!entry) continue
      const cat = (entry.byCategory[row.category] ??= { budget: 0, used: 0 })
      cat.used += row.claim_amount
      entry.totalUsed += row.claim_amount
    }
  }

  for (const e of ongoingRows ?? []) {
    const entry = result[e.site_id]
    if (!entry) continue
    const recognized = e.amount - e.over_limit_amount
    const cat = (entry.byCategory[e.category] ??= { budget: 0, used: 0 })
    cat.used += recognized
    entry.totalUsed += recognized
  }

  return result
}
