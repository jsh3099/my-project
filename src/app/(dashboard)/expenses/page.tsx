import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import { PlusCircle } from 'lucide-react'
import { ExpenseList } from '@/components/expenses/ExpenseList'
import type { Expense, Site } from '@/types'

function currentYearMonth() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

export default async function ExpensesPage({
  searchParams,
}: {
  searchParams: Promise<{ month?: string; site?: string }>
}) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const params = await searchParams
  const ym = params.month ?? currentYearMonth()

  const { data: assignments } = await supabase
    .from('user_site_assignments')
    .select('site_id, sites(id, name)')
    .eq('user_id', user.id)
    .eq('is_active', true)

  const sites = (assignments?.map((a) => a.sites).filter(Boolean) ?? []) as unknown as Site[]
  const selectedSiteId = params.site ?? sites[0]?.id ?? ''

  let expenses: Expense[] = []
  if (selectedSiteId) {
    const { data } = await supabase
      .from('expenses')
      .select('*')
      .eq('site_id', selectedSiteId)
      .eq('user_id', user.id)
      .eq('year_month', ym)
      .is('deleted_at', null)
      .order('expense_date', { ascending: false })
    expenses = (data ?? []) as Expense[]
  }

  const totalAmount = expenses.reduce((s, e) => s + e.amount, 0)
  const approvedAmount = expenses
    .filter((e) => e.status === 'approved')
    .reduce((s, e) => s + e.amount, 0)

  // 제출 가능한지 (draft 항목이 1개 이상 있어야)
  const hasDraft = expenses.some((e) => e.status === 'draft')
  const allSubmitted = expenses.length > 0 && !hasDraft

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-gray-900">월별 비용 내역</h1>
          <p className="mt-1 text-sm text-gray-500">입력한 직접경비를 확인하고 본사에 제출하세요.</p>
        </div>
        <Link
          href="/expenses/new"
          className="flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700"
        >
          <PlusCircle className="h-4 w-4" />
          비용 입력
        </Link>
      </div>

      {/* 필터: 현장 + 월 */}
      <div className="flex flex-wrap gap-3 rounded-xl border border-gray-200 bg-white p-4">
        {sites.length > 1 && (
          <div>
            <label className="mb-1 block text-xs text-gray-500">현장</label>
            <SiteSelect sites={sites} selectedSiteId={selectedSiteId} ym={ym} />
          </div>
        )}
        <div>
          <label className="mb-1 block text-xs text-gray-500">월</label>
          <MonthSelect ym={ym} siteId={selectedSiteId} />
        </div>
      </div>

      {/* 요약 */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
        <div className="rounded-xl border border-gray-200 bg-white p-4">
          <p className="text-xs text-gray-500">총 입력액</p>
          <p className="mt-1 text-lg font-bold text-gray-900">{totalAmount.toLocaleString()}원</p>
          <p className="text-xs text-gray-400">{expenses.length}건</p>
        </div>
        <div className="rounded-xl border border-green-200 bg-green-50 p-4">
          <p className="text-xs text-gray-500">승인 금액</p>
          <p className="mt-1 text-lg font-bold text-green-700">{approvedAmount.toLocaleString()}원</p>
          <p className="text-xs text-gray-400">{expenses.filter((e) => e.status === 'approved').length}건</p>
        </div>
        <div className={`rounded-xl border p-4 ${allSubmitted ? 'border-yellow-200 bg-yellow-50' : 'border-gray-200 bg-white'}`}>
          <p className="text-xs text-gray-500">상태</p>
          <p className={`mt-1 text-lg font-bold ${allSubmitted ? 'text-yellow-600' : 'text-gray-700'}`}>
            {allSubmitted ? '검토중' : hasDraft ? '작성중' : '없음'}
          </p>
        </div>
      </div>

      <ExpenseList
        expenses={expenses}
        siteId={selectedSiteId}
        yearMonth={ym}
        hasDraft={hasDraft}
      />
    </div>
  )
}

function SiteSelect({ sites, selectedSiteId, ym }: { sites: Site[]; selectedSiteId: string; ym: string }) {
  return (
    <form>
      <input type="hidden" name="month" value={ym} />
      <select
        name="site"
        defaultValue={selectedSiteId}
        className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm"
        onChange={(e) => {
          const url = new URL(window.location.href)
          url.searchParams.set('site', e.target.value)
          window.location.href = url.toString()
        }}
      >
        {sites.map((s) => (
          <option key={s.id} value={s.id}>{s.name}</option>
        ))}
      </select>
    </form>
  )
}

function MonthSelect({ ym, siteId }: { ym: string; siteId: string }) {
  const months: string[] = []
  const now = new Date()
  for (let i = 0; i < 6; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1)
    months.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`)
  }

  return (
    <select
      defaultValue={ym}
      className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm"
      onChange={(e) => {
        const url = new URL(window.location.href)
        url.searchParams.set('month', e.target.value)
        if (siteId) url.searchParams.set('site', siteId)
        window.location.href = url.toString()
      }}
    >
      {months.map((m) => (
        <option key={m} value={m}>{m.replace('-', '년 ')}월</option>
      ))}
    </select>
  )
}
