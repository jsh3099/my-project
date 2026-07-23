import Link from 'next/link'
import { notFound } from 'next/navigation'
import { ChevronLeft } from 'lucide-react'
import { createClient } from '@/lib/supabase/server'
import { createSettlementRound } from '@/actions/settlementRounds'
import { SettlementRoundForm } from '@/components/sites/SettlementRoundForm'
import { ConfirmRoundButton } from '@/components/sites/ConfirmRoundButton'
import { buildCategorySummaryTree } from '@/lib/expenseSummaryTree'
import type { SettlementRound } from '@/types'

interface Props {
  params: Promise<{ siteId: string }>
}

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

  const [{ data: site }, { data: rounds }] = await Promise.all([
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
  ])

  if (!site) notFound()

  const allRounds = (rounds ?? []) as SettlementRound[]
  const openRound = allRounds.find((r) => r.status === 'open') ?? null
  const confirmedRounds = allRounds.filter((r) => r.status === 'confirmed')
  const latestConfirmed = confirmedRounds[confirmedRounds.length - 1] ?? null
  const priorCumulative = latestConfirmed
    ? latestConfirmed.prior_cumulative_amount + latestConfirmed.current_round_amount
    : 0

  // 진행 중인 회차의 잠정 사용액 미리보기 (제출됨 + 아직 어느 회차에도 속하지 않은 건)
  let previewTree: ReturnType<typeof buildCategorySummaryTree> = []
  let previewTotal = 0
  if (openRound) {
    const { data: previewExpenses } = await supabase
      .from('expenses')
      .select('category, subcategory, amount, over_limit_amount')
      .eq('site_id', siteId)
      .eq('status', 'submitted')
      .is('settlement_round_id', null)
      .is('deleted_at', null)
      .gte('expense_date', openRound.period_start)
      .lte('expense_date', openRound.period_end)

    const entries = (previewExpenses ?? []).map((e) => ({
      category: e.category,
      subcategory: e.subcategory,
      amount: e.amount - e.over_limit_amount,
    }))
    previewTotal = entries.reduce((s, e) => s + e.amount, 0)
    previewTree = buildCategorySummaryTree(entries)
  }

  const previewRemaining = site.direct_expense_budget - priorCumulative - previewTotal
  const isFinalRound = openRound ? openRound.period_end >= site.contract_end : false

  const lastRound = allRounds[allRounds.length - 1] ?? null
  const nextRoundNo = (lastRound?.round_no ?? 0) + 1
  const defaultPeriodStart = lastRound ? addDaysISO(lastRound.period_end, 1) : site.contract_start
  const createAction = createSettlementRound.bind(null, siteId)

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <Link href="/admin/sites" className="flex items-center gap-1 text-sm text-gray-500 hover:text-gray-900">
          <ChevronLeft className="h-4 w-4" />
          현장 목록으로
        </Link>
        <h2 className="mt-3 text-xl font-semibold text-gray-900">기성회차 정산 — {site.name}</h2>
        <p className="mt-1 text-sm text-gray-500">
          직접경비 계상금액 {formatKRW(site.direct_expense_budget)} · 계약기간 {site.contract_start} ~ {site.contract_end}
        </p>
      </div>

      {/* 확정된 회차 이력 */}
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
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {confirmedRounds.map((r) => {
                const remaining = site.direct_expense_budget - (r.prior_cumulative_amount + r.current_round_amount)
                return (
                  <tr key={r.id}>
                    <td className="px-4 py-3 font-medium text-gray-900">{r.round_no}회차</td>
                    <td className="px-4 py-3 text-gray-600">{r.period_start} ~ {r.period_end}</td>
                    <td className="px-4 py-3 text-right text-gray-600">{formatKRW(r.prior_cumulative_amount)}</td>
                    <td className="px-4 py-3 text-right text-gray-900 font-medium">{formatKRW(r.current_round_amount)}</td>
                    <td className={`px-4 py-3 text-right font-medium ${remaining < 0 ? 'text-red-600' : 'text-blue-600'}`}>
                      {formatKRW(remaining)}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          {latestConfirmed && latestConfirmed.period_end >= site.contract_end && previewRemaining > 0 && (
            <div className="border-t border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
              ⚠ 계약기간이 종료된 이후에도 잔액이 {formatKRW(previewRemaining)} 남아있습니다 — 삭감 대상인지 확인이 필요합니다.
            </div>
          )}
        </div>
      )}

      {/* 진행 중인 회차: 미리보기 + 확정 */}
      {openRound && (
        <div className="rounded-lg border border-blue-200 bg-white p-6 space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-gray-800">
              {openRound.round_no}회차 진행 중 — {openRound.period_start} ~ {openRound.period_end}
            </h3>
          </div>

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

          <div className="border-t pt-3 space-y-1 text-sm">
            <div className="flex justify-between text-gray-600">
              <span>전회기성금액</span>
              <span>{formatKRW(priorCumulative)}</span>
            </div>
            <div className="flex justify-between font-semibold text-gray-900">
              <span>금회기성금액 (잠정)</span>
              <span>{formatKRW(previewTotal)}</span>
            </div>
            <div className="flex justify-between font-semibold text-blue-700">
              <span>잔액 (잠정)</span>
              <span>{formatKRW(previewRemaining)}</span>
            </div>
          </div>

          {previewRemaining > 0 && (
            <div className={`rounded-lg border p-3 text-sm ${isFinalRound ? 'border-red-300 bg-red-50 text-red-700' : 'border-yellow-300 bg-yellow-50 text-yellow-700'}`}>
              ⚠ 잔액이 {formatKRW(previewRemaining)} 남아있습니다 — 계약기간 내 직접경비 예산을 다 사용하지 못하면
              미사용분만큼 용역비가 삭감되고 실제 사용한 금액만 지급됩니다.
              {isFinalRound && ' 이번 회차 기간이 계약 종료일을 포함하므로 특히 주의가 필요합니다.'}
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
