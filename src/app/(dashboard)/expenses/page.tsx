import Link from 'next/link'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { ChevronRight, Plus } from 'lucide-react'

const MONTHS = ['1월', '2월', '3월', '4월', '5월', '6월', '7월', '8월', '9월', '10월', '11월', '12월']

export default async function ExpensesPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const now = new Date()
  const currentYear = now.getFullYear()
  const currentMonth = now.getMonth() + 1

  // 최근 6개월 집계
  const months: { year: number; month: number }[] = []
  for (let i = 5; i >= 0; i--) {
    const d = new Date(currentYear, currentMonth - 1 - i, 1)
    months.push({ year: d.getFullYear(), month: d.getMonth() + 1 })
  }

  // 월별 비용 합계
  const { data: summaries } = await supabase
    .from('expenses')
    .select('year, month, amount, disallowed_amount, submission_status')
    .eq('submitted_by', user.id)
    .in('year', [...new Set(months.map((m) => m.year))])

  const summaryMap: Record<string, { total: number; submitted: number; draft: number }> = {}
  for (const e of summaries ?? []) {
    const key = `${e.year}_${e.month}`
    if (!summaryMap[key]) summaryMap[key] = { total: 0, submitted: 0, draft: 0 }
    summaryMap[key].total += e.amount - e.disallowed_amount
    if (e.submission_status === 'submitted') summaryMap[key].submitted++
    else summaryMap[key].draft++
  }

  return (
    <div className="p-8 max-w-3xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-xl font-bold text-gray-900">직접경비 입력</h1>
        <Link
          href={`/expenses/${currentYear}/${currentMonth}/new`}
          className="flex items-center gap-1.5 rounded-md bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-700"
        >
          <Plus className="h-4 w-4" />
          비용 입력
        </Link>
      </div>

      <div className="space-y-3">
        {months.map(({ year, month }) => {
          const key = `${year}_${month}`
          const s = summaryMap[key]
          return (
            <Link
              key={key}
              href={`/expenses/${year}/${month}`}
              className="flex items-center justify-between rounded-lg border border-gray-200 bg-white px-5 py-4 hover:border-blue-300 hover:shadow-sm transition-all"
            >
              <div>
                <p className="text-sm font-semibold text-gray-800">
                  {year}년 {MONTHS[month - 1]}
                </p>
                {s ? (
                  <p className="mt-0.5 text-xs text-gray-500">
                    {s.total.toLocaleString()}원 · 임시저장 {s.draft}건 · 제출됨 {s.submitted}건
                  </p>
                ) : (
                  <p className="mt-0.5 text-xs text-gray-400">입력 없음</p>
                )}
              </div>
              <ChevronRight className="h-4 w-4 text-gray-400" />
            </Link>
          )
        })}
      </div>
    </div>
  )
}
