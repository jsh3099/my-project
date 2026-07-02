import Link from 'next/link'
import { redirect, notFound } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { Plus } from 'lucide-react'
import { ExpenseList } from '@/components/expenses/ExpenseList'
import { ExpenseSummary } from '@/components/expenses/ExpenseSummary'
import { SubmitAllButton } from '@/components/expenses/SubmitAllButton'

interface Props {
  params: Promise<{ year: string; month: string }>
}

export default async function MonthlyExpensePage({ params }: Props) {
  const { year: yearStr, month: monthStr } = await params
  const year = parseInt(yearStr, 10)
  const month = parseInt(monthStr, 10)

  if (isNaN(year) || isNaN(month) || month < 1 || month > 12) notFound()

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: expenses } = await supabase
    .from('expenses')
    .select('*')
    .eq('submitted_by', user.id)
    .eq('year', year)
    .eq('month', month)
    .order('expense_date', { ascending: true })

  // 사용자 소속 현장의 예산 (첫번째 현장 기준)
  const { data: assignment } = await supabase
    .from('user_site_assignments')
    .select('site_id, sites(direct_expense_budget)')
    .eq('user_id', user.id)
    .eq('is_active', true)
    .limit(1)
    .single()

  const budget = (assignment?.sites as { direct_expense_budget?: number } | null)?.direct_expense_budget ?? 0
  const list = expenses ?? []
  const hasDraft = list.some((e) => e.submission_status === 'draft')
  const firstSiteId = assignment?.site_id ?? ''

  return (
    <div className="p-8 max-w-4xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <Link href="/expenses" className="text-sm text-blue-600 hover:underline">← 목록으로</Link>
          <h1 className="text-xl font-bold text-gray-900 mt-1">
            {year}년 {month}월 직접경비
          </h1>
        </div>
        <div className="flex gap-3">
          {hasDraft && firstSiteId && (
            <SubmitAllButton siteId={firstSiteId} year={year} month={month} />
          )}
          <Link
            href={`/expenses/${year}/${month}/new`}
            className="flex items-center gap-1.5 rounded-md bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-700"
          >
            <Plus className="h-4 w-4" />
            비용 추가
          </Link>
        </div>
      </div>

      <div className="mb-6">
        <ExpenseSummary expenses={list} budget={budget} />
      </div>

      <div className="rounded-lg border border-gray-200 bg-white overflow-hidden">
        <ExpenseList expenses={list} />
      </div>
    </div>
  )
}
