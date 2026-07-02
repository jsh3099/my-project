import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import { PlusCircle, ClipboardList, AlertTriangle, CheckCircle, Clock, TrendingUp } from 'lucide-react'
import { EXPENSE_CATEGORY_LABELS, EXPENSE_STATUS_LABELS, type ExpenseCategory } from '@/lib/constants'
import type { Expense, Site } from '@/types'

function formatKRW(n: number) {
  return n.toLocaleString('ko-KR') + '원'
}

function currentYearMonth() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

export default async function DashboardPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: profile } = await supabase
    .from('profiles')
    .select('role, full_name')
    .eq('id', user.id)
    .single()

  const ym = currentYearMonth()

  // 배정된 현장 목록
  const { data: assignments } = await supabase
    .from('user_site_assignments')
    .select('site_id, sites(id, name, direct_expense_budget, status)')
    .eq('user_id', user.id)
    .eq('is_active', true)

  const sites = (assignments?.map((a) => a.sites).filter(Boolean) ?? []) as unknown as Site[]
  const siteIds = sites.map((s) => s.id)

  // 이번 달 비용 내역
  let expenses: Expense[] = []
  if (siteIds.length > 0) {
    const { data } = await supabase
      .from('expenses')
      .select('*')
      .in('site_id', siteIds)
      .eq('user_id', user.id)
      .eq('year_month', ym)
      .is('deleted_at', null)
      .order('expense_date', { ascending: false })
    expenses = (data ?? []) as Expense[]
  }

  const totalAmount = expenses.reduce((s, e) => s + e.amount, 0)
  const overLimitCount = expenses.filter((e) => e.is_over_limit).length
  const submittedCount = expenses.filter((e) => e.status === 'submitted').length
  const approvedCount = expenses.filter((e) => e.status === 'approved').length

  // 비목별 합계
  const byCategory: Record<string, number> = {}
  for (const e of expenses) {
    byCategory[e.category] = (byCategory[e.category] ?? 0) + e.amount
  }

  const totalBudget = sites.reduce((s, site) => s + (site.direct_expense_budget ?? 0), 0)

  return (
    <div className="space-y-6">
      {/* 헤더 */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">안녕하세요, {profile?.full_name}님 👋</h1>
          <p className="mt-1 text-sm text-gray-500">{ym.replace('-', '년 ')}월 직접경비 현황</p>
        </div>
        <Link
          href="/expenses/new"
          className="flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white shadow hover:bg-blue-700 transition-colors"
        >
          <PlusCircle className="h-4 w-4" />
          비용 입력
        </Link>
      </div>

      {/* 배정된 현장이 없는 경우 */}
      {sites.length === 0 && (
        <div className="rounded-xl border border-yellow-200 bg-yellow-50 p-6 text-center">
          <AlertTriangle className="mx-auto mb-2 h-8 w-8 text-yellow-500" />
          <p className="font-medium text-yellow-800">배정된 현장이 없습니다</p>
          <p className="mt-1 text-sm text-yellow-600">시스템 관리자에게 현장 배정을 요청하세요.</p>
        </div>
      )}

      {sites.length > 0 && (
        <>
          {/* 요약 카드 4개 */}
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <div className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
              <p className="text-xs font-medium text-gray-500">이번 달 총 사용액</p>
              <p className="mt-2 text-2xl font-bold text-gray-900">{formatKRW(totalAmount)}</p>
              {totalBudget > 0 && (
                <p className="mt-1 text-xs text-gray-400">예산 {formatKRW(totalBudget)}</p>
              )}
            </div>

            <div className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
              <p className="text-xs font-medium text-gray-500">입력 건수</p>
              <p className="mt-2 text-2xl font-bold text-gray-900">{expenses.length}건</p>
              <p className="mt-1 text-xs text-gray-400">이번 달 전체</p>
            </div>

            <div className={`rounded-xl border p-5 shadow-sm ${submittedCount > 0 ? 'border-yellow-200 bg-yellow-50' : 'border-gray-200 bg-white'}`}>
              <p className="text-xs font-medium text-gray-500">검토 중</p>
              <p className={`mt-2 text-2xl font-bold ${submittedCount > 0 ? 'text-yellow-600' : 'text-gray-900'}`}>
                {submittedCount}건
              </p>
              <p className="mt-1 text-xs text-gray-400">본사 확인 대기</p>
            </div>

            <div className={`rounded-xl border p-5 shadow-sm ${overLimitCount > 0 ? 'border-red-200 bg-red-50' : 'border-green-200 bg-green-50'}`}>
              <p className="text-xs font-medium text-gray-500">한도 초과</p>
              <p className={`mt-2 text-2xl font-bold ${overLimitCount > 0 ? 'text-red-600' : 'text-green-600'}`}>
                {overLimitCount}건
              </p>
              <p className="mt-1 text-xs text-gray-400">{overLimitCount === 0 ? '모두 정상' : '불인정 처리됨'}</p>
            </div>
          </div>

          {/* 비목별 사용 현황 */}
          {Object.keys(byCategory).length > 0 && (
            <div className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
              <h2 className="mb-4 flex items-center gap-2 text-sm font-semibold text-gray-700">
                <TrendingUp className="h-4 w-4 text-blue-500" />
                비목별 사용 현황
              </h2>
              <div className="space-y-3">
                {Object.entries(byCategory).map(([cat, amt]) => {
                  const pct = totalAmount > 0 ? Math.round((amt / totalAmount) * 100) : 0
                  return (
                    <div key={cat}>
                      <div className="mb-1 flex justify-between text-xs text-gray-600">
                        <span>{EXPENSE_CATEGORY_LABELS[cat as ExpenseCategory] ?? cat}</span>
                        <span className="font-medium">{formatKRW(amt)} ({pct}%)</span>
                      </div>
                      <div className="h-2 w-full rounded-full bg-gray-100">
                        <div
                          className="h-2 rounded-full bg-blue-500"
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {/* 최근 입력 내역 */}
          <div className="rounded-xl border border-gray-200 bg-white shadow-sm">
            <div className="flex items-center justify-between border-b border-gray-100 px-6 py-4">
              <h2 className="flex items-center gap-2 text-sm font-semibold text-gray-700">
                <ClipboardList className="h-4 w-4 text-blue-500" />
                최근 입력 내역
              </h2>
              <Link href="/expenses" className="text-xs text-blue-600 hover:underline">
                전체 보기 →
              </Link>
            </div>

            {expenses.length === 0 ? (
              <div className="py-12 text-center">
                <p className="text-sm text-gray-400">이번 달 입력된 비용이 없습니다.</p>
                <Link
                  href="/expenses/new"
                  className="mt-3 inline-flex items-center gap-1 text-sm font-medium text-blue-600 hover:underline"
                >
                  <PlusCircle className="h-4 w-4" />
                  첫 비용 입력하기
                </Link>
              </div>
            ) : (
              <div className="divide-y divide-gray-50">
                {expenses.slice(0, 5).map((expense) => (
                  <div key={expense.id} className="flex items-center justify-between px-6 py-3">
                    <div>
                      <p className="text-sm font-medium text-gray-800">
                        {EXPENSE_CATEGORY_LABELS[expense.category as ExpenseCategory] ?? expense.category}
                      </p>
                      <p className="text-xs text-gray-400">{expense.expense_date}</p>
                    </div>
                    <div className="text-right">
                      <p className={`text-sm font-semibold ${expense.is_over_limit ? 'text-red-500' : 'text-gray-900'}`}>
                        {formatKRW(expense.amount)}
                        {expense.is_over_limit && <span className="ml-1 text-xs">(초과)</span>}
                      </p>
                      <StatusBadge status={expense.status} />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* 빠른 액션 */}
          <div className="grid grid-cols-2 gap-4">
            <Link
              href="/expenses/new"
              className="flex items-center gap-3 rounded-xl border-2 border-dashed border-blue-300 bg-blue-50 p-5 text-blue-700 transition hover:border-blue-400 hover:bg-blue-100"
            >
              <PlusCircle className="h-6 w-6" />
              <div>
                <p className="font-semibold">비용 입력</p>
                <p className="text-xs text-blue-500">영수증 업로드 포함</p>
              </div>
            </Link>
            <Link
              href="/expenses"
              className="flex items-center gap-3 rounded-xl border-2 border-dashed border-gray-300 bg-gray-50 p-5 text-gray-700 transition hover:border-gray-400 hover:bg-gray-100"
            >
              <ClipboardList className="h-6 w-6" />
              <div>
                <p className="font-semibold">월별 내역 조회</p>
                <p className="text-xs text-gray-400">수정·삭제·제출</p>
              </div>
            </Link>
          </div>
        </>
      )}
    </div>
  )
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    draft: 'bg-gray-100 text-gray-600',
    submitted: 'bg-yellow-100 text-yellow-700',
    approved: 'bg-green-100 text-green-700',
    rejected: 'bg-red-100 text-red-700',
  }
  return (
    <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${map[status] ?? 'bg-gray-100 text-gray-600'}`}>
      {EXPENSE_STATUS_LABELS[status as keyof typeof EXPENSE_STATUS_LABELS] ?? status}
    </span>
  )
}
