'use client'

import { useState, useTransition } from 'react'
import { Trash2, Send, ChevronDown, ChevronUp, Receipt } from 'lucide-react'
import { EXPENSE_CATEGORY_LABELS, EXPENSE_SUBCATEGORIES, type ExpenseCategory } from '@/lib/constants'
import { deleteExpense, submitExpenses } from '@/actions/expenses'
import { useRouter } from 'next/navigation'
import type { Expense } from '@/types'

interface Props {
  expenses: Expense[]
  siteId: string
  yearMonth: string
  hasDraft: boolean
}

const STATUS_STYLE: Record<string, string> = {
  draft: 'bg-gray-100 text-gray-600',
  submitted: 'bg-yellow-100 text-yellow-700',
  approved: 'bg-green-100 text-green-700',
  rejected: 'bg-red-100 text-red-700',
}
const STATUS_LABEL: Record<string, string> = {
  draft: '작성중',
  submitted: '검토중',
  approved: '승인',
  rejected: '반려',
}

function getSubLabel(category: string, subcategory: string) {
  const subs = EXPENSE_SUBCATEGORIES[category as ExpenseCategory] ?? []
  return subs.find((s) => s.value === subcategory)?.label ?? subcategory
}

export function ExpenseList({ expenses, siteId, yearMonth, hasDraft }: Props) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [submitConfirm, setSubmitConfirm] = useState(false)
  const [message, setMessage] = useState('')

  const handleDelete = (id: string) => {
    if (!confirm('이 비용 항목을 삭제하시겠어요?')) return
    startTransition(async () => {
      const result = await deleteExpense(id)
      if (result.error) setMessage(result.error)
      else { setMessage('삭제됐습니다.'); router.refresh() }
    })
  }

  const handleSubmit = () => {
    startTransition(async () => {
      const result = await submitExpenses(siteId, yearMonth)
      if (result.error) setMessage(result.error)
      else { setMessage('본사에 제출됐습니다!'); setSubmitConfirm(false); router.refresh() }
    })
  }

  if (expenses.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-gray-300 py-16 text-center">
        <p className="text-gray-400">이 달에 입력된 비용이 없습니다.</p>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {message && (
        <div className="rounded-lg border border-blue-200 bg-blue-50 p-3 text-sm text-blue-700">
          {message}
        </div>
      )}

      {/* 본사 제출 버튼 */}
      {hasDraft && (
        <div className="rounded-xl border border-blue-200 bg-blue-50 p-4">
          {!submitConfirm ? (
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-semibold text-blue-800">본사 제출 준비 완료</p>
                <p className="text-xs text-blue-600">작성중인 항목을 본사에 제출합니다.</p>
              </div>
              <button
                onClick={() => setSubmitConfirm(true)}
                className="flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700"
              >
                <Send className="h-4 w-4" />
                본사 제출
              </button>
            </div>
          ) : (
            <div className="space-y-3">
              <p className="text-sm font-semibold text-blue-800">
                {yearMonth.replace('-', '년 ')}월 비용 내역을 본사에 제출하시겠습니까?
              </p>
              <p className="text-xs text-blue-600">제출 후에는 수정이 불가합니다.</p>
              <div className="flex gap-2">
                <button
                  onClick={() => setSubmitConfirm(false)}
                  className="rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm text-gray-700 hover:bg-gray-50"
                >취소</button>
                <button
                  onClick={handleSubmit}
                  disabled={isPending}
                  className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
                >{isPending ? '제출 중...' : '제출 확인'}</button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* 목록 */}
      <div className="overflow-hidden rounded-xl border border-gray-200 bg-white">
        <div className="divide-y divide-gray-100">
          {expenses.map((expense) => (
            <div key={expense.id}>
              <button
                type="button"
                className="w-full px-5 py-4 text-left transition hover:bg-gray-50"
                onClick={() => setExpandedId(expandedId === expense.id ? null : expense.id)}
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLE[expense.status]}`}>
                      {STATUS_LABEL[expense.status]}
                    </span>
                    <div>
                      <p className="text-sm font-medium text-gray-800">
                        {EXPENSE_CATEGORY_LABELS[expense.category as ExpenseCategory] ?? expense.category}
                        <span className="ml-1 text-gray-400">›</span>
                        <span className="ml-1 text-gray-500">{getSubLabel(expense.category, expense.subcategory)}</span>
                      </p>
                      <p className="text-xs text-gray-400">{expense.expense_date}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <div className="text-right">
                      <p className={`text-sm font-semibold ${expense.is_over_limit ? 'text-red-500' : 'text-gray-900'}`}>
                        {expense.amount.toLocaleString()}원
                      </p>
                      {expense.is_over_limit && (
                        <p className="text-xs text-red-400">초과 {expense.over_limit_amount.toLocaleString()}원</p>
                      )}
                    </div>
                    {expandedId === expense.id
                      ? <ChevronUp className="h-4 w-4 text-gray-400" />
                      : <ChevronDown className="h-4 w-4 text-gray-400" />
                    }
                  </div>
                </div>
              </button>

              {/* 상세 펼침 */}
              {expandedId === expense.id && (
                <div className="border-t border-gray-100 bg-gray-50 px-5 py-4 space-y-3">
                  {expense.memo && (
                    <p className="text-sm text-gray-600"><span className="font-medium">메모:</span> {expense.memo}</p>
                  )}
                  {expense.headcount > 1 && (
                    <p className="text-sm text-gray-600"><span className="font-medium">인원:</span> {expense.headcount}명</p>
                  )}
                  {expense.is_over_limit && (
                    <div className="rounded-lg bg-red-100 px-3 py-2 text-xs text-red-700">
                      ⚠️ 한도 초과 {expense.over_limit_amount.toLocaleString()}원은 불인정 처리됩니다.
                    </div>
                  )}
                  {expense.rejection_reason && (
                    <div className="rounded-lg bg-red-100 px-3 py-2 text-xs text-red-700">
                      반려 사유: {expense.rejection_reason}
                    </div>
                  )}
                  {expense.receipt_urls.length > 0 && (
                    <div>
                      <p className="mb-2 text-xs font-medium text-gray-500">첨부 영수증</p>
                      <div className="flex flex-wrap gap-2">
                        {expense.receipt_urls.map((url, i) => (
                          <a
                            key={i}
                            href={url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="flex items-center gap-1 rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-xs text-blue-600 hover:bg-blue-50"
                          >
                            <Receipt className="h-3 w-3" />
                            영수증 {i + 1}
                          </a>
                        ))}
                      </div>
                    </div>
                  )}
                  {expense.status === 'draft' && (
                    <button
                      onClick={() => handleDelete(expense.id)}
                      disabled={isPending}
                      className="flex items-center gap-1 text-xs text-red-500 hover:text-red-700"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                      삭제
                    </button>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
