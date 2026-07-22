import type { Expense } from '@/types'
import { buildCategorySummaryTree } from '@/lib/expenseSummaryTree'

interface ExpenseSummaryProps {
  expenses: Expense[]
  budget: number
}

export function ExpenseSummary({ expenses, budget }: ExpenseSummaryProps) {
  // 비목별 합계 (대분류 → 중분류 소계 → 세부항목, 정산서 3.1 서식 기준)
  let totalNormal = 0
  let totalDisallowed = 0

  const netEntries = expenses.map((e) => {
    const net = e.amount - e.disallowed_amount
    totalNormal += net
    totalDisallowed += e.disallowed_amount
    return { category: e.category, subcategory: e.subcategory, amount: net }
  })

  const categoryTree = buildCategorySummaryTree(netEntries)

  const remaining = budget - totalNormal

  const submittedCount = expenses.filter((e) => e.submission_status === 'submitted').length
  const draftCount = expenses.filter((e) => e.submission_status === 'draft').length

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
      {/* 비목별 합계 */}
      <div className="col-span-1 sm:col-span-2 rounded-lg border border-gray-200 bg-white p-5">
        <p className="text-sm font-semibold text-gray-700 mb-3">비목별 합계</p>
        <div className="space-y-3">
          {categoryTree.map((cat) => (
            <div key={cat.category}>
              <div className="flex justify-between text-sm font-semibold text-gray-800">
                <span>{cat.label}</span>
                <span>{cat.amount.toLocaleString()}원</span>
              </div>
              {cat.midGroups.map((mid) => (
                <div key={mid.midCategory} className="mt-1 ml-3 space-y-0.5">
                  <div className="flex justify-between text-xs font-medium text-gray-600">
                    <span>{mid.label} 소계</span>
                    <span>{mid.amount.toLocaleString()}원</span>
                  </div>
                  {mid.subs.map((s) => (
                    <div key={s.subcategory} className="ml-3 flex justify-between text-xs text-gray-500">
                      <span>· {s.label}</span>
                      <span>{s.amount.toLocaleString()}원</span>
                    </div>
                  ))}
                </div>
              ))}
              {cat.subs.length > 0 && (
                <div className="mt-1 ml-3 space-y-0.5">
                  {cat.subs.map((s) => (
                    <div key={s.subcategory} className="flex justify-between text-xs text-gray-500">
                      <span>· {s.label}</span>
                      <span>{s.amount.toLocaleString()}원</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
          {categoryTree.length === 0 && (
            <p className="text-sm text-gray-400">입력된 항목 없음</p>
          )}
        </div>
        <div className="mt-3 pt-3 border-t flex justify-between text-sm font-semibold">
          <span>합계 (정상)</span>
          <span>{totalNormal.toLocaleString()}원</span>
        </div>
        {totalDisallowed > 0 && (
          <div className="flex justify-between text-sm text-red-600">
            <span>불인정 합계</span>
            <span>{totalDisallowed.toLocaleString()}원</span>
          </div>
        )}
      </div>

      {/* 잔여 예산 */}
      <div className="rounded-lg border border-gray-200 bg-white p-5">
        <p className="text-sm font-semibold text-gray-700 mb-1">잔여 예산</p>
        <p className={`text-2xl font-bold ${remaining < 0 ? 'text-red-600' : 'text-blue-600'}`}>
          {remaining.toLocaleString()}원
        </p>
        <p className="text-xs text-gray-400 mt-1">예산 {budget.toLocaleString()}원</p>
      </div>

      {/* 제출 현황 */}
      <div className="rounded-lg border border-gray-200 bg-white p-5">
        <p className="text-sm font-semibold text-gray-700 mb-3">제출 현황</p>
        <div className="space-y-2">
          <div className="flex justify-between text-sm">
            <span className="text-gray-600">임시저장</span>
            <span className="font-medium text-gray-700">{draftCount}건</span>
          </div>
          <div className="flex justify-between text-sm">
            <span className="text-gray-600">제출됨</span>
            <span className="font-medium text-blue-600">{submittedCount}건</span>
          </div>
          <div className="flex justify-between text-sm">
            <span className="text-gray-600">전체</span>
            <span className="font-medium">{expenses.length}건</span>
          </div>
        </div>
      </div>
    </div>
  )
}
