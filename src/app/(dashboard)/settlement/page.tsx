import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { ReportDownloadButton } from '@/components/settlement/ReportDownloadButton'
import { SiteBudgetForm } from '@/components/settlement/SiteBudgetForm'
import { updateSiteExpenseBudgets } from '@/actions/siteBudgets'
import { calcClaim } from '@/lib/settlement'
import { EXPENSE_CATEGORY_LABELS, type ExpenseCategory } from '@/lib/constants'
import type { Site, SettlementRound, SettlementRoundItem } from '@/types'

const CATEGORY_KEYS = Object.keys(EXPENSE_CATEGORY_LABELS) as ExpenseCategory[]

function formatKRW(n: number) {
  return n.toLocaleString('ko-KR') + '원'
}

export default async function StaffSettlementPage({
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
    .select('site_id, sites(*)')
    .eq('user_id', user.id)
    .eq('is_active', true)

  const sites = ((assignments ?? []).map((a) => a.sites).filter(Boolean) as unknown) as Site[]
  const siteId = params.site ?? sites[0]?.id ?? ''
  const site = sites.find((s) => s.id === siteId)

  if (!site) {
    return <div className="p-8 text-center text-sm text-gray-400">배정된 현장이 없습니다.</div>
  }

  const [{ data: roundsData }, { data: budgetRows }] = await Promise.all([
    supabase
      .from('settlement_rounds')
      .select('*')
      .eq('site_id', siteId)
      .order('round_no', { ascending: true }),
    supabase
      .from('site_expense_budgets')
      .select('category, amount')
      .eq('site_id', siteId),
  ])

  const rounds = (roundsData ?? []) as SettlementRound[]
  const openRound = rounds.find((r) => r.status === 'open') ?? null
  const confirmedRounds = rounds.filter((r) => r.status === 'confirmed')
  // 누계는 청구(기성)액 기준 — 잔액 초과 사용분(미지급)은 누계에 포함하지 않는다
  const priorCumulative = confirmedRounds.reduce((s, r) => s + r.claim_amount, 0)

  // 항목별 계상금액 (미입력 항목은 0)
  const budgetByCategory = new Map<string, number>(
    (budgetRows ?? []).map((b) => [b.category, b.amount]),
  )
  const hasItemBudgets = [...budgetByCategory.values()].some((v) => v > 0)

  // 항목별 전회 누계 청구액 — 확정 회차 스냅샷 기준
  const priorClaimByCategory = new Map<string, number>()
  if (confirmedRounds.length > 0) {
    const { data: itemRows } = await supabase
      .from('settlement_round_items')
      .select('category, claim_amount')
      .in('round_id', confirmedRounds.map((r) => r.id))
    for (const row of (itemRows ?? []) as Pick<SettlementRoundItem, 'category' | 'claim_amount'>[]) {
      priorClaimByCategory.set(row.category, (priorClaimByCategory.get(row.category) ?? 0) + row.claim_amount)
    }
  }

  // 진행 중인 회차의 잠정 사용액 (현장 전체 인원 합계 — admin client로 본인 제출건 외에도 조회)
  const usedByCategory = new Map<string, number>()
  if (openRound) {
    const admin = createAdminClient()
    const { data: previewExpenses } = await admin
      .from('expenses')
      .select('category, amount, over_limit_amount')
      .eq('site_id', siteId)
      .in('status', ['submitted', 'approved'])
      .is('settlement_round_id', null)
      .is('deleted_at', null)
      .gte('expense_date', openRound.period_start)
      .lte('expense_date', openRound.period_end)
    for (const e of previewExpenses ?? []) {
      usedByCategory.set(e.category, (usedByCategory.get(e.category) ?? 0) + (e.amount - e.over_limit_amount))
    }
  }

  // 청구액 산정: 청구 = min(사용액, 계상총액 잔액), 항목 초과는 총액 내 흡수
  const claim = calcClaim({
    totalBudget: site.direct_expense_budget,
    priorClaimTotal: priorCumulative,
    items: CATEGORY_KEYS.map((category) => ({
      category,
      contractAmount: budgetByCategory.get(category) ?? 0,
      priorCumulative: priorClaimByCategory.get(category) ?? 0,
      usedAmount: usedByCategory.get(category) ?? 0,
    })),
  })
  const budgetRemainAfter = site.direct_expense_budget - priorCumulative - claim.claimTotal
  const showStatusTable = hasItemBudgets || priorCumulative > 0 || claim.usedTotal > 0
  const budgetShortfall = openRound?.budgeted_amount
    ? openRound.budgeted_amount - claim.usedTotal
    : 0

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div>
        <h1 className="text-xl font-bold text-gray-900">기성회차 현황</h1>
        <p className="mt-1 text-sm text-gray-500">
          {site.name} · 직접경비 계상금액 {formatKRW(site.direct_expense_budget)} · 계약기간 {site.contract_start} ~ {site.contract_end}
        </p>
      </div>

      {sites.length > 1 && (
        <form method="get" className="flex flex-wrap gap-3 rounded-xl border border-gray-200 bg-white p-4">
          <div>
            <label className="mb-1 block text-xs text-gray-500">현장</label>
            <select name="site" defaultValue={siteId} className="rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none">
              {sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </div>
          <div className="flex items-end">
            <button type="submit" className="rounded-lg bg-gray-100 px-3 py-2 text-sm text-gray-700 hover:bg-gray-200">조회</button>
          </div>
        </form>
      )}

      {/* 항목별 계상금액 입력 — 내역서의 계상금액을 기재해야 사용액·잔액 추적이 시작된다 */}
      <SiteBudgetForm
        siteId={siteId}
        budgets={Object.fromEntries(budgetByCategory) as Partial<Record<ExpenseCategory, number>>}
        action={updateSiteExpenseBudgets.bind(null, siteId)}
      />

      {/* 항목별 계상 대비 현황 (읽기 전용) */}
      {showStatusTable && (
        <div className="rounded-lg border border-gray-200 bg-white p-6 space-y-4">
          <h3 className="text-sm font-semibold text-gray-800">항목별 계상 대비 현황</h3>
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="border-b border-gray-200 text-xs text-gray-500">
                  <th className="py-2 text-left font-medium">항목</th>
                  <th className="py-2 text-right font-medium">계약금액(계상)</th>
                  <th className="py-2 text-right font-medium">누계기성</th>
                  {openRound && <th className="py-2 text-right font-medium">금회사용</th>}
                  {openRound && <th className="py-2 text-right font-medium">금회기성(잠정)</th>}
                  <th className="py-2 text-right font-medium">잔액</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {claim.items
                  .filter((i) => i.contractAmount > 0 || i.priorCumulative > 0 || i.usedAmount > 0)
                  .map((i) => (
                    <tr key={i.category}>
                      <td className="py-2 text-gray-700">{EXPENSE_CATEGORY_LABELS[i.category as ExpenseCategory]}</td>
                      <td className="py-2 text-right text-gray-600">{i.contractAmount > 0 ? formatKRW(i.contractAmount) : '-'}</td>
                      <td className="py-2 text-right text-gray-600">{formatKRW(i.priorCumulative)}</td>
                      {openRound && <td className="py-2 text-right text-gray-600">{formatKRW(i.usedAmount)}</td>}
                      {openRound && <td className="py-2 text-right font-medium text-gray-900">{formatKRW(i.claimAmount)}</td>}
                      <td className={`py-2 text-right ${i.contractAmount > 0 && i.remaining < 0 ? 'text-orange-600 font-medium' : 'text-gray-600'}`}>
                        {i.contractAmount > 0 ? formatKRW(i.remaining) : '-'}
                      </td>
                    </tr>
                  ))}
                <tr className="border-t border-gray-300 font-semibold">
                  <td className="py-2 text-gray-900">합계</td>
                  <td className="py-2 text-right text-gray-900">{formatKRW(site.direct_expense_budget)}</td>
                  <td className="py-2 text-right text-gray-900">{formatKRW(priorCumulative)}</td>
                  {openRound && <td className="py-2 text-right text-gray-900">{formatKRW(claim.usedTotal)}</td>}
                  {openRound && <td className="py-2 text-right text-blue-700">{formatKRW(claim.claimTotal)}</td>}
                  <td className={`py-2 text-right ${budgetRemainAfter < 0 ? 'text-red-600' : 'text-blue-700'}`}>
                    {formatKRW(budgetRemainAfter)}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          {/* 경고: 잔액 초과 사용 → 미지급 */}
          {claim.unpaidAmount > 0 && (
            <div className="rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-700">
              ⚠ 금회 사용액 {formatKRW(claim.usedTotal)} 중 계상 잔액({formatKRW(claim.remainingBudget)})을 초과한{' '}
              <span className="font-semibold">{formatKRW(claim.unpaidAmount)}은 발주청에 청구할 수 없습니다.</span>{' '}
              항목 이동·증감 여부는 본사 정산 담당자에게 문의하세요.
            </div>
          )}

          {/* 경고: 항목별 초과 (총액 내 흡수) */}
          {claim.unpaidAmount === 0 &&
            claim.items.some((i) => i.contractAmount > 0 && i.remaining < 0) && (
              <div className="rounded-lg border border-orange-300 bg-orange-50 p-3 text-sm text-orange-700">
                일부 항목이 항목별 계상금액을 초과했지만, 직접경비 총액 내이므로 타 항목 잔액에서 흡수 가능합니다.
              </div>
            )}

          {/* 경고: 금회 계상액 대비 부족 → 증빙 보완 필요 */}
          {budgetShortfall > 0 && (
            <div className="rounded-lg border border-yellow-300 bg-yellow-50 p-3 text-sm text-yellow-700">
              금회 계상금액 {formatKRW(openRound!.budgeted_amount!)} 대비 제출된 사용액이{' '}
              <span className="font-semibold">{formatKRW(budgetShortfall)} 부족</span>합니다 —
              증빙으로 채우지 못한 계상분은 발주청이 삭감 후 지급하니, 사용한 비용을 빠짐없이 입력·제출해주세요.
            </div>
          )}
        </div>
      )}

      {confirmedRounds.length > 0 && (
        <div className="overflow-hidden rounded-lg border border-gray-200 bg-white">
          <table className="min-w-full divide-y divide-gray-200 text-sm">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-4 py-2 text-left font-medium text-gray-500">회차</th>
                <th className="px-4 py-2 text-left font-medium text-gray-500">정산기간</th>
                <th className="px-4 py-2 text-right font-medium text-gray-500">전회기성</th>
                <th className="px-4 py-2 text-right font-medium text-gray-500">금회기성</th>
                <th className="px-4 py-2 text-right font-medium text-gray-500">잔액</th>
                <th className="px-4 py-2 text-center font-medium text-gray-500">정산서</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {confirmedRounds.map((r) => {
                const remaining = site.direct_expense_budget - (r.prior_cumulative_amount + r.claim_amount)
                const unpaid = r.current_round_amount - r.claim_amount
                return (
                  <tr key={r.id}>
                    <td className="px-4 py-3 font-medium text-gray-900">{r.round_no}회차</td>
                    <td className="px-4 py-3 text-gray-600">{r.period_start} ~ {r.period_end}</td>
                    <td className="px-4 py-3 text-right text-gray-600">{formatKRW(r.prior_cumulative_amount)}</td>
                    <td className="px-4 py-3 text-right text-gray-900 font-medium">
                      {formatKRW(r.claim_amount)}
                      {unpaid > 0 && (
                        <span className="block text-xs text-red-500">미지급 {formatKRW(unpaid)}</span>
                      )}
                    </td>
                    <td className={`px-4 py-3 text-right font-medium ${remaining < 0 ? 'text-red-600' : 'text-blue-600'}`}>
                      {formatKRW(remaining)}
                    </td>
                    <td className="px-4 py-3 text-center">
                      <ReportDownloadButton siteId={siteId} roundId={r.id} label="엑셀" />
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {openRound ? (
        <div className="rounded-lg border border-blue-200 bg-white p-6 space-y-3">
          <h3 className="text-sm font-semibold text-gray-800">
            {openRound.round_no}회차 진행 중 — {openRound.period_start} ~ {openRound.period_end}
          </h3>
          <div className="space-y-1 text-sm">
            <div className="flex justify-between text-gray-600">
              <span>전회기성금액</span>
              <span>{formatKRW(priorCumulative)}</span>
            </div>
            <div className="flex justify-between text-gray-600">
              <span>금회사용액 (잠정)</span>
              <span>{formatKRW(claim.usedTotal)}</span>
            </div>
            <div className="flex justify-between font-semibold text-gray-900">
              <span>금회기성금액 (잠정)</span>
              <span>{formatKRW(claim.claimTotal)}</span>
            </div>
            <div className="flex justify-between font-semibold text-blue-700">
              <span>잔액 (잠정)</span>
              <span>{formatKRW(budgetRemainAfter)}</span>
            </div>
          </div>
          {budgetRemainAfter > 0 && (
            <div className="rounded-lg border border-yellow-300 bg-yellow-50 p-3 text-sm text-yellow-700">
              ⚠ 잔액이 남아있습니다. 계약기간 내 직접경비 예산을 다 사용하지 못하면 미사용분만큼 삭감될 수 있으니,
              사용한 비용은 빠짐없이 입력·제출해주세요.
            </div>
          )}
          <ReportDownloadButton siteId={siteId} roundId={openRound.id} label="📄 잠정 정산서 엑셀" />
        </div>
      ) : (
        <div className="rounded-lg border border-dashed border-gray-300 bg-white p-6 space-y-3 text-center text-sm text-gray-400">
          <p>진행 중인 회차가 없습니다. 본사 정산 담당자에게 문의하세요.</p>
          <ReportDownloadButton siteId={siteId} label="📄 잠정 정산서 엑셀 (미편입 지출)" />
        </div>
      )}
    </div>
  )
}
