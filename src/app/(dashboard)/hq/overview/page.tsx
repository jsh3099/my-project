import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { Badge } from '@/components/ui/Badge'
import { Receipt } from 'lucide-react'
import type { Site } from '@/types'

function formatKRW(n: number) {
  return n.toLocaleString('ko-KR') + '원'
}

export default async function HqOverviewPage() {
  const supabase = await createClient()

  const [{ data: sitesData }, { data: expensesData }, { data: roundsData }] = await Promise.all([
    supabase.from('sites').select('*').is('deleted_at', null).order('created_at', { ascending: false }),
    supabase
      .from('expenses')
      .select('site_id, status, amount, over_limit_amount')
      .is('deleted_at', null),
    supabase.from('settlement_rounds').select('site_id, status'),
  ])

  const sites = (sitesData ?? []) as Site[]
  const expenses = expensesData ?? []
  const rounds = roundsData ?? []

  const statsBySite = new Map<string, { approved: number; submitted: number; draft: number }>()
  for (const e of expenses) {
    const s = statsBySite.get(e.site_id) ?? { approved: 0, submitted: 0, draft: 0 }
    if (e.status === 'approved') s.approved += e.amount - e.over_limit_amount
    else if (e.status === 'submitted') s.submitted += 1
    else if (e.status === 'draft') s.draft += 1
    statsBySite.set(e.site_id, s)
  }

  const openRoundSites = new Set(rounds.filter((r) => r.status === 'open').map((r) => r.site_id))
  const confirmedRoundSites = new Set(rounds.filter((r) => r.status === 'confirmed').map((r) => r.site_id))

  function deriveStatus(siteId: string, submittedCount: number) {
    if (submittedCount > 0) return { label: '검토중', variant: 'yellow' as const }
    if (openRoundSites.has(siteId)) return { label: '입력중', variant: 'blue' as const }
    if (confirmedRoundSites.has(siteId)) return { label: '확정', variant: 'green' as const }
    return { label: '대기', variant: 'gray' as const }
  }

  const totalBudget = sites.reduce((s, site) => s + (site.direct_expense_budget ?? 0), 0)
  const totalApproved = sites.reduce((s, site) => s + (statsBySite.get(site.id)?.approved ?? 0), 0)
  const totalPendingReview = sites.reduce((s, site) => s + (statsBySite.get(site.id)?.submitted ?? 0), 0)

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold text-gray-900">전체 현황</h2>
        <p className="mt-1 text-sm text-gray-500">전 현장의 직접경비 예산·사용·검토 현황을 한눈에 확인합니다.</p>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div className="rounded-xl border border-gray-200 bg-white p-5">
          <p className="text-xs font-medium text-gray-500">전 현장 직접경비 예산</p>
          <p className="mt-2 text-xl font-bold text-gray-900">{formatKRW(totalBudget)}</p>
        </div>
        <div className="rounded-xl border border-gray-200 bg-white p-5">
          <p className="text-xs font-medium text-gray-500">확정 누적 사용액</p>
          <p className="mt-2 text-xl font-bold text-gray-900">{formatKRW(totalApproved)}</p>
        </div>
        <div className={`rounded-xl border p-5 ${totalPendingReview > 0 ? 'border-yellow-200 bg-yellow-50' : 'border-gray-200 bg-white'}`}>
          <p className="text-xs font-medium text-gray-500">본사 검토 대기</p>
          <p className={`mt-2 text-xl font-bold ${totalPendingReview > 0 ? 'text-yellow-600' : 'text-gray-900'}`}>{totalPendingReview}건</p>
        </div>
      </div>

      {sites.length === 0 ? (
        <div className="rounded-lg border border-dashed border-gray-300 bg-white py-16 text-center text-sm text-gray-400">
          등록된 현장이 없습니다.
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
          <table className="min-w-[720px] w-full divide-y divide-gray-200 text-sm">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-4 py-3 text-left font-medium text-gray-500">현장</th>
                <th className="px-4 py-3 text-right font-medium text-gray-500">직접경비 예산</th>
                <th className="px-4 py-3 text-right font-medium text-gray-500">확정 사용액</th>
                <th className="px-4 py-3 text-right font-medium text-gray-500">잔액</th>
                <th className="px-4 py-3 text-center font-medium text-gray-500">검토대기</th>
                <th className="px-4 py-3 text-center font-medium text-gray-500">상태</th>
                <th className="px-4 py-3 text-center font-medium text-gray-500">정산</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {sites.map((site) => {
                const stats = statsBySite.get(site.id) ?? { approved: 0, submitted: 0, draft: 0 }
                const remaining = (site.direct_expense_budget ?? 0) - stats.approved
                const status = deriveStatus(site.id, stats.submitted)
                return (
                  <tr key={site.id} className="hover:bg-gray-50">
                    <td className="px-4 py-3 font-medium text-gray-900 whitespace-nowrap">{site.name}</td>
                    <td className="px-4 py-3 text-right text-gray-600">{formatKRW(site.direct_expense_budget ?? 0)}</td>
                    <td className="px-4 py-3 text-right text-gray-900">{formatKRW(stats.approved)}</td>
                    <td className={`px-4 py-3 text-right font-medium ${remaining < 0 ? 'text-red-600' : 'text-blue-600'}`}>
                      {formatKRW(remaining)}
                    </td>
                    <td className="px-4 py-3 text-center">
                      {stats.submitted > 0 ? (
                        <span className="font-semibold text-yellow-600">{stats.submitted}건</span>
                      ) : (
                        <span className="text-gray-400">-</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-center">
                      <Badge variant={status.variant}>{status.label}</Badge>
                    </td>
                    <td className="px-4 py-3 text-center">
                      <Link
                        href={`/admin/sites/${site.id}/settlement`}
                        className="inline-flex items-center gap-1 text-blue-600 hover:underline"
                      >
                        <Receipt className="h-4 w-4" />
                        상세
                      </Link>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
