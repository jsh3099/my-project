import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import type { Site, SettlementRound } from '@/types'

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

  const { data: roundsData } = await supabase
    .from('settlement_rounds')
    .select('*')
    .eq('site_id', siteId)
    .order('round_no', { ascending: true })

  const rounds = (roundsData ?? []) as SettlementRound[]
  const openRound = rounds.find((r) => r.status === 'open') ?? null
  const confirmedRounds = rounds.filter((r) => r.status === 'confirmed')
  const latestConfirmed = confirmedRounds[confirmedRounds.length - 1] ?? null
  const priorCumulative = latestConfirmed
    ? latestConfirmed.prior_cumulative_amount + latestConfirmed.current_round_amount
    : 0

  // 진행 중인 회차의 잠정 사용액 (현장 전체 인원 합계 — admin client로 본인 제출건 외에도 조회)
  let previewTotal = 0
  if (openRound) {
    const admin = createAdminClient()
    const { data: previewExpenses } = await admin
      .from('expenses')
      .select('amount, over_limit_amount')
      .eq('site_id', siteId)
      .eq('status', 'submitted')
      .is('settlement_round_id', null)
      .is('deleted_at', null)
      .gte('expense_date', openRound.period_start)
      .lte('expense_date', openRound.period_end)
    previewTotal = (previewExpenses ?? []).reduce((s, e) => s + (e.amount - e.over_limit_amount), 0)
  }

  const previewRemaining = site.direct_expense_budget - priorCumulative - previewTotal

  return (
    <div className="mx-auto max-w-3xl space-y-6">
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
            <div className="rounded-lg border border-yellow-300 bg-yellow-50 p-3 text-sm text-yellow-700">
              ⚠ 잔액이 남아있습니다. 계약기간 내 직접경비 예산을 다 사용하지 못하면 미사용분만큼 삭감될 수 있으니,
              사용한 비용은 빠짐없이 입력·제출해주세요.
            </div>
          )}
        </div>
      ) : (
        <div className="rounded-lg border border-dashed border-gray-300 bg-white p-6 text-center text-sm text-gray-400">
          진행 중인 회차가 없습니다. 본사 정산 담당자에게 문의하세요.
        </div>
      )}
    </div>
  )
}
