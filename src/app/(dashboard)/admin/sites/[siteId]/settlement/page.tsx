import Link from 'next/link'
import { notFound } from 'next/navigation'
import { ChevronLeft } from 'lucide-react'
import { createClient } from '@/lib/supabase/server'
import { createSettlementRound } from '@/actions/settlementRounds'
import { SettlementRoundForm } from '@/components/sites/SettlementRoundForm'
import { ConfirmRoundButton } from '@/components/sites/ConfirmRoundButton'
import { ReportDownloadButton } from '@/components/settlement/ReportDownloadButton'
import { buildCategorySummaryTree } from '@/lib/expenseSummaryTree'
import { calcClaim } from '@/lib/settlement'
import { EXPENSE_CATEGORY_LABELS, type ExpenseCategory } from '@/lib/constants'
import type { SettlementRound, SettlementRoundItem } from '@/types'

interface Props {
  params: Promise<{ siteId: string }>
}

const CATEGORY_KEYS = Object.keys(EXPENSE_CATEGORY_LABELS) as ExpenseCategory[]

function formatKRW(n: number) {
  return n.toLocaleString('ko-KR') + '원'
}

function addDaysISO(dateStr: string, days: number) {
  const d = new Date(dateStr)
  d.setDate(d.getDate() + days)
  return d.toISOString().split('T')[0]
}

export default async function SettlementRoundsPage({ params }: Props) {
  const { siteId } = await params
  const supabase = await createClient()

  const [{ data: site }, { data: rounds }, { data: budgetRows }] = await Promise.all([
    supabase
      .from('sites')
      .select('id, name, contract_start, contract_end, direct_expense_budget')
      .eq('id', siteId)
      .is('deleted_at', null)
      .single(),
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

  if (!site) notFound()

  const allRounds = (rounds ?? []) as SettlementRound[]
  const openRound = allRounds.find((r) => r.status === 'open') ?? null
  const confirmedRounds = allRounds.filter((r) => r.status === 'confirmed')

  // 항목별 계상금액 (미입력 항목은 0)
  const budgetByCategory = new Map<string, number>(
    (budgetRows ?? []).map((b) => [b.category, b.amount]),
  )
  const hasItemBudgets = [...budgetByCategory.values()].some((v) => v > 0)

  // 전회 누계 청구액 (총액 + 항목별) — 확정 회차 스냅샷 기준
  const priorClaimTotal = confirmedRounds.reduce((s, r) => s + r.claim_amount, 0)
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

  // 진행 중인 회차의 잠정 사용액 미리보기 (제출됨 + 아직 어느 회차에도 속하지 않은 건)
  let previewTree: ReturnType<typeof buildCategorySummaryTree> = []
  let usedByCategory = new Map<string, number>()
  if (openRound) {
    const { data: previewExpenses } = await supabase
      .from('expenses')
      .select('category, subcategory, amount, over_limit_amount')
      .eq('site_id', siteId)
      .in('status', ['submitted', 'approved'])
      .is('settlement_round_id', null)
      .is('deleted_at', null)
      .gte('expense_date', openRound.period_start)
      .lte('expense_date', openRound.period_end)

    const entries = (previewExpenses ?? []).map((e) => ({
      category: e.category,
      subcategory: e.subcategory,
      amount: e.amount - e.over_limit_amount,
    }))
    previewTree = buildCategorySummaryTree(entries)
    usedByCategory = entries.reduce((m, e) => {
      m.set(e.category, (m.get(e.category) ?? 0) + e.amount)
      return m
    }, new Map<string, number>())
  }

  // 청구액 산정: 청구 = min(사용액, 계상총액 잔액), 항목 초과는 총액 내 흡수
  const claim = calcClaim({
    totalBudget: site.direct_expense_budget,
    priorClaimTotal,
    items: CATEGORY_KEYS.map((category) => ({
      category,
      contractAmount: budgetByCategory.get(category) ?? 0,
      priorCumulative: priorClaimByCategory.get(category) ?? 0,
      usedAmount: usedByCategory.get(category) ?? 0,
    })),
  })
  const budgetRemainAfter = site.direct_expense_budget - priorClaimTotal - claim.claimTotal
  const isFinalRound = openRound ? openRound.period_end >= site.contract_end : false
  const budgetShortfall = openRound?.budgeted_amount
    ? openRound.budgeted_amount - claim.usedTotal
    : 0

  const lastRound = allRounds[allRounds.length - 1] ?? null
  const nextRoundNo = (lastRound?.round_no ?? 0) + 1
  const defaultPeriodStart = lastRound ? addDaysISO(lastRound.period_end, 1) : site.contract_start
  const createAction = createSettlementRound.bind(null, siteId)

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div>
        <Link href="/admin/sites" className="flex items-center gap-1 text-sm text-gray-500 hover:text-gray-900">
          <ChevronLeft className="h-4 w-4" />
          현장 목록으로
        </Link>
        <h2 className="mt-3 text-xl font-semibold text-gray-900">기성회차 정산 — {site.name}</h2>
        <p className="mt-1 text-sm text-gray-500">
          직접경비 계상총액 {formatKRW(site.direct_expense_budget)} · 계약기간 {site.contract_start} ~ {site.contract_end}
        </p>
        {!hasItemBudgets && (
          <p className="mt-2 rounded-md bg-yellow-50 px-3 py-2 text-xs text-yellow-700">
            항목별 계상금액이 아직 입력되지 않았습니다.{' '}
            <Link href={`/admin/sites/${siteId}`} className="font-medium underline">
              현장 수정
            </Link>
            에서 주재비·출장비·도서인쇄비 등 항목별 계상금액을 입력하면 정산서 2번 표(계약금액/잔액)가 채워집니다.
          </p>
        )}
      </div>

      {/* 확정된 회차 이력 */}
      {confirmedRounds.length > 0 && (
        <div className="overflow-hidden rounded-lg border border-gray-200 bg-white">
          <table className="min-w-full divide-y divide-gray-200 text-sm">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-4 py-2 text-left font-medium text-gray-500">회차</th>
                <th className="px-4 py-2 text-left font-medium text-gray-500">정산기간</th>
                <th className="px-4 py-2 text-right font-medium text-gray-500">금회계상</th>
                <th className="px-4 py-2 text-right font-medium text-gray-500">전회누계(기성)</th>
                <th className="px-4 py-2 text-right font-medium text-gray-500">금회사용</th>
                <th className="px-4 py-2 text-right font-medium text-gray-500">금회기성(청구)</th>
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
                    <td className="px-4 py-3 text-right text-gray-600">
                      {r.budgeted_amount ? formatKRW(r.budgeted_amount) : '-'}
                    </td>
                    <td className="px-4 py-3 text-right text-gray-600">{formatKRW(r.prior_cumulative_amount)}</td>
                    <td className="px-4 py-3 text-right text-gray-600">
                      {formatKRW(r.current_round_amount)}
                      {unpaid > 0 && (
                        <span className="block text-xs text-red-500">미지급 {formatKRW(unpaid)}</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right font-medium text-gray-900">{formatKRW(r.claim_amount)}</td>
                    <td className={`px-4 py-3 text-right font-medium ${remaining < 0 ? 'text-red-600' : 'text-blue-600'}`}>
                      {formatKRW(remaining)}
                    </td>
                    <td className="px-4 py-3 text-center">
                      <span className="inline-flex gap-1">
                        <ReportDownloadButton siteId={siteId} roundId={r.id} label="엑셀" />
                        <ReportDownloadButton siteId={siteId} roundId={r.id} label="PDF" format="pdf" />
                      </span>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          {confirmedRounds[confirmedRounds.length - 1].period_end >= site.contract_end && budgetRemainAfter > 0 && (
            <div className="border-t border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
              ⚠ 계약기간이 종료된 이후에도 잔액이 {formatKRW(budgetRemainAfter)} 남아있습니다 — 삭감 대상인지 확인이 필요합니다.
            </div>
          )}
        </div>
      )}

      {/* 진행 중인 회차: 계상 대비 청구 미리보기 + 확정 */}
      {openRound && (
        <div className="rounded-lg border border-blue-200 bg-white p-6 space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-gray-800">
              {openRound.round_no}회차 진행 중 — {openRound.period_start} ~ {openRound.period_end}
            </h3>
            <span className="inline-flex gap-2">
              <ReportDownloadButton siteId={siteId} roundId={openRound.id} label="📄 잠정 정산서 엑셀" />
              <ReportDownloadButton siteId={siteId} roundId={openRound.id} label="📄 잠정 정산서 PDF" format="pdf" />
            </span>
          </div>

          {/* 항목별 계상 대비 사용·청구 (정산서 2번 표 미리보기) */}
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="border-b border-gray-200 text-xs text-gray-500">
                  <th className="py-2 text-left font-medium">항목</th>
                  <th className="py-2 text-right font-medium">계약금액(계상)</th>
                  <th className="py-2 text-right font-medium">전회누계</th>
                  <th className="py-2 text-right font-medium">금회사용</th>
                  <th className="py-2 text-right font-medium">금회기성(잠정)</th>
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
                      <td className="py-2 text-right text-gray-600">{formatKRW(i.usedAmount)}</td>
                      <td className="py-2 text-right font-medium text-gray-900">{formatKRW(i.claimAmount)}</td>
                      <td className={`py-2 text-right font-medium ${i.contractAmount <= 0 ? 'text-gray-600' : i.remaining <= 0 ? 'text-blue-600' : 'text-red-600'}`}>
                        {i.contractAmount > 0 ? formatKRW(i.remaining) : '-'}
                      </td>
                    </tr>
                  ))}
                <tr className="border-t border-gray-300 font-semibold">
                  <td className="py-2 text-gray-900">합계</td>
                  <td className="py-2 text-right text-gray-900">{formatKRW(site.direct_expense_budget)}</td>
                  <td className="py-2 text-right text-gray-900">{formatKRW(priorClaimTotal)}</td>
                  <td className="py-2 text-right text-gray-900">{formatKRW(claim.usedTotal)}</td>
                  <td className="py-2 text-right text-blue-700">{formatKRW(claim.claimTotal)}</td>
                  <td className={`py-2 text-right ${budgetRemainAfter > 0 ? 'text-red-600' : 'text-blue-700'}`}>
                    {formatKRW(budgetRemainAfter)}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          {/* 세부 사용내역 트리 */}
          <div className="space-y-2 text-sm">
            {previewTree.map((cat) => (
              <div key={cat.category}>
                <div className="flex justify-between font-semibold text-gray-800">
                  <span>{cat.label}</span>
                  <span>{formatKRW(cat.amount)}</span>
                </div>
                {cat.midGroups.map((mid) => (
                  <div key={mid.midCategory} className="ml-3 mt-1 space-y-0.5">
                    <div className="flex justify-between text-xs font-medium text-gray-600">
                      <span>{mid.label} 소계</span>
                      <span>{formatKRW(mid.amount)}</span>
                    </div>
                    {mid.subs.map((s) => (
                      <div key={s.subcategory} className="ml-3 flex justify-between text-xs text-gray-500">
                        <span>· {s.label}</span>
                        <span>{formatKRW(s.amount)}</span>
                      </div>
                    ))}
                  </div>
                ))}
                {cat.subs.length > 0 && (
                  <div className="ml-3 mt-1 space-y-0.5">
                    {cat.subs.map((s) => (
                      <div key={s.subcategory} className="flex justify-between text-xs text-gray-500">
                        <span>· {s.label}</span>
                        <span>{formatKRW(s.amount)}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
            {previewTree.length === 0 && (
              <p className="text-gray-400">본사 제출된 항목이 아직 없습니다.</p>
            )}
          </div>

          {/* 경고: 잔액 초과 사용 → 미지급 */}
          {claim.unpaidAmount > 0 && (
            <div className="rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-700">
              ⚠ 사용액 {formatKRW(claim.usedTotal)} 중 계상 잔액({formatKRW(claim.remainingBudget)})을 초과한{' '}
              <span className="font-semibold">{formatKRW(claim.unpaidAmount)}은 발주청에 청구할 수 없습니다</span> —
              금회 기성 청구액은 {formatKRW(claim.claimTotal)}로 제한됩니다.
            </div>
          )}

          {/* 안내: 항목별 초과 (총액 내 흡수 — 정상, 파랑) */}
          {claim.unpaidAmount === 0 &&
            claim.items.some((i) => i.contractAmount > 0 && i.remaining < 0) && (
              <div className="rounded-lg border border-blue-300 bg-blue-50 p-3 text-sm text-blue-700">
                일부 항목이 계상금액을 초과 충족했습니다 — 직접경비 총액 내이므로 초과분은 타 항목 잔액에서
                흡수되어 정상 지급됩니다 (국토교통부 고시 제2023-580호 별표2 — 항목별 비용은 직접경비 내에서 변경 가능).
              </div>
            )}

          {/* 경고: 금회 계상액 대비 부족 → 예상 삭감 (빨강) */}
          {budgetShortfall > 0 && (
            <div className="rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-700">
              금회 계상금액 {formatKRW(openRound.budgeted_amount!)} 중 증빙으로 채우지 못한{' '}
              <span className="font-semibold">{formatKRW(budgetShortfall)}이 삭감 후 지급</span>됩니다.
            </div>
          )}

          {/* 경고: 계약 종료 임박 잔액 */}
          {budgetRemainAfter > 0 && isFinalRound && (
            <div className="rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-700">
              ⚠ 이번 회차 기간이 계약 종료일을 포함하는데 잔액이 {formatKRW(budgetRemainAfter)} 남아있습니다 —
              미사용분만큼 용역비가 삭감되고 실제 사용한 금액만 지급됩니다.
            </div>
          )}

          <ConfirmRoundButton siteId={siteId} roundId={openRound.id} roundNo={openRound.round_no} />
        </div>
      )}

      {/* 새 회차 시작 */}
      {!openRound && (
        <div className="rounded-lg border border-gray-200 bg-white p-6">
          <SettlementRoundForm
            nextRoundNo={nextRoundNo}
            defaultPeriodStart={defaultPeriodStart}
            action={createAction}
          />
        </div>
      )}
    </div>
  )
}
