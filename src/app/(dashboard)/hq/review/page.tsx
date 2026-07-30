import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { ReviewList, type ReviewExpense } from '@/components/expenses/ReviewList'

// 본사 제출 검토 (F-17): 전 현장의 제출(submitted) 건을 개별 승인·반려한다.
export default async function HqReviewPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: profile } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .single()
  if (profile?.role !== 'hq_officer' && profile?.role !== 'system_admin') redirect('/dashboard')

  // 제출자·현장 이름 포함 조회 — RLS 우회가 필요하므로 역할 확인 후 admin client 사용
  const admin = createAdminClient()
  const { data: rows } = await admin
    .from('expenses')
    .select('id, site_id, category, subcategory, amount, over_limit_amount, is_over_limit, expense_date, year_month, period_start, period_end, target_user_name, memo, receipt_urls, user_id, sites(id, name)')
    .eq('status', 'submitted')
    .is('settlement_round_id', null)
    .is('deleted_at', null)
    .order('expense_date', { ascending: true })

  // 제출자 이름 매핑
  const submitterIds = [...new Set((rows ?? []).map((r) => r.user_id))]
  const { data: submitters } = submitterIds.length
    ? await admin.from('profiles').select('id, full_name').in('id', submitterIds)
    : { data: [] }
  const nameById = new Map((submitters ?? []).map((p) => [p.id, p.full_name]))

  const expenses: ReviewExpense[] = (rows ?? []).map((r) => {
    const site = (Array.isArray(r.sites) ? r.sites[0] : r.sites) as { id: string; name: string } | null
    return {
      id: r.id,
      siteId: r.site_id,
      siteName: site?.name ?? '(현장 미상)',
      category: r.category,
      subcategory: r.subcategory,
      amount: r.amount,
      overLimitAmount: r.over_limit_amount,
      isOverLimit: r.is_over_limit,
      expenseDate: r.expense_date,
      yearMonth: r.year_month,
      periodStart: r.period_start,
      periodEnd: r.period_end,
      targetUserName: r.target_user_name,
      memo: r.memo,
      receiptUrls: r.receipt_urls ?? [],
      submitterName: nameById.get(r.user_id) ?? '(알 수 없음)',
    }
  })

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div>
        <h2 className="text-xl font-semibold text-gray-900">제출 검토</h2>
        <p className="mt-1 text-sm text-gray-500">
          현장에서 제출한 비용을 승인하거나 반려합니다. 반려 시 사유가 현장 직원에게 표시되며,
          승인된 건과 미검토 제출건은 기성회차 확정 시 함께 편입됩니다 (반려 건 제외).
        </p>
      </div>
      <ReviewList expenses={expenses} />
    </div>
  )
}
