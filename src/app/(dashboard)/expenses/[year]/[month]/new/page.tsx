import Link from 'next/link'
import { redirect, notFound } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { ExpenseForm } from '@/components/expenses/ExpenseForm'
import type { Site } from '@/types'

interface Props {
  params: Promise<{ year: string; month: string }>
}

export default async function NewExpensePage({ params }: Props) {
  const { year: yearStr, month: monthStr } = await params
  const year = parseInt(yearStr, 10)
  const month = parseInt(monthStr, 10)

  if (isNaN(year) || isNaN(month) || month < 1 || month > 12) notFound()

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  // 사용자 소속 현장 조회
  const { data: assignments } = await supabase
    .from('user_site_assignments')
    .select('site_id, sites(id, name, client_name, contract_start, contract_end, contract_amount, direct_expense_budget, status, created_by, created_at, updated_at, deleted_at)')
    .eq('user_id', user.id)
    .eq('is_active', true)

  const sites = ((assignments ?? []).map((a) => a.sites).filter(Boolean) as unknown) as Site[]

  const defaultSiteId = sites[0]?.id

  return (
    <div className="p-8 max-w-2xl mx-auto">
      <div className="mb-6">
        <Link href={`/expenses/${year}/${month}`} className="text-sm text-blue-600 hover:underline">
          ← {year}년 {month}월 목록으로
        </Link>
        <h1 className="text-xl font-bold text-gray-900 mt-1">비용 입력</h1>
        <p className="text-sm text-gray-500">{year}년 {month}월</p>
      </div>

      <div className="rounded-lg border border-gray-200 bg-white p-6">
        <ExpenseForm
          sites={sites}
          defaultSiteId={defaultSiteId}
          defaultYear={year}
          defaultMonth={month}
        />
      </div>
    </div>
  )
}
