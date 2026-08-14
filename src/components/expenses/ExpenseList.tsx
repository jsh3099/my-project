'use client'

import { useState, useTransition } from 'react'
import { Trash2, Send, ChevronDown, ChevronUp, Receipt } from 'lucide-react'
import { EXPENSE_CATEGORY_LABELS, EXPENSE_SUBCATEGORIES, type ExpenseCategory } from '@/lib/constants'
import { deleteExpense, submitExpenses } from '@/actions/expenses'
import { receiptHref } from '@/lib/storage/receipts'
import { useRouter } from 'next/navigation'
import type { Expense } from '@/types'

interface Props {
  expenses: Expense[]
  siteId: string
  yearMonth: string
  hasDraft: boolean
  /** 진행 중 기성회차 — 제출은 회차 기성기간 전체 단위 (없으면 월 단위 폴백) */
  round?: {
    label: string
    draftCount: number; draftAmount: number
    /** 이미 제출·승인된 건 — 제출할 것이 없을 때 상태를 보여주기 위해 */
    sentCount: number; sentAmount: number
  } | null
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

export function ExpenseList({ expenses, siteId, yearMonth, hasDraft, round = null }: Props) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [submitConfirm, setSubmitConfirm] = useState(false)
  const [message, setMessage] = useState('')
  // 삭제 확인은 화면 안에서 받는다 — window.confirm은 미리보기 패널 등 일부 환경에서
  // 대화상자 없이 즉시 false를 반환해 "눌러도 아무 일 없는" 상태가 된다.
  // 같은 화면의 본사 제출(submitConfirm)과 같은 2단계 방식으로 통일한다.
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null)

  const handleDelete = (id: string) => {
    setDeleteConfirmId(null)
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

  // 제출은 회차 단위 — 조회 중인 달에 draft가 없어도 회차의 다른 달에 남아있으면 배너를 보인다
  const submittable = round ? round.draftCount > 0 : hasDraft
  const submitScopeLabel = round ? `${round.label} 기성기간 전체` : `${yearMonth.replace('-', '년 ')}월`

  return (
    <div className="space-y-4">
      {message && (
        <div className="rounded-lg border border-blue-200 bg-blue-50 p-3 text-sm text-blue-700">
          {message}
        </div>
      )}

      {/* 본사 제출 버튼 — 기성(정산)이 회차 단위이므로 회차 기간의 작성중 항목을 한 번에 제출한다 */}
      {submittable && (
        <div className="rounded-xl border border-blue-200 bg-blue-50 p-4">
          {!submitConfirm ? (
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-semibold text-blue-800">본사 제출 준비 완료</p>
                <p className="text-xs text-blue-600">
                  {round
                    ? <>{round.label} 작성중 <b>{round.draftCount}건 · {round.draftAmount.toLocaleString()}원</b>을 본사에 제출합니다. (조회 월과 무관하게 회차 전체)</>
                    : '작성중인 항목을 본사에 제출합니다.'}
                </p>
              </div>
              {/* type을 명시한다 — 없으면 암묵적 submit이라 나중에 form 안으로 옮길 때
                  의도치 않게 폼이 제출된다. 이 파일만 빠져 있었다(코드베이스 나머지는 전부 명시). */}
              <button
                type="button"
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
                {submitScopeLabel}의 비용 내역{round ? ` ${round.draftCount}건 (${round.draftAmount.toLocaleString()}원)` : ''}을 본사에 제출하시겠습니까?
              </p>
              <p className="text-xs text-blue-600">제출 후에는 수정이 불가합니다.</p>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setSubmitConfirm(false)}
                  className="rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm text-gray-700 hover:bg-gray-50"
                >취소</button>
                <button
                  type="button"
                  onClick={handleSubmit}
                  disabled={isPending}
                  className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
                >{isPending ? '제출 중...' : '제출 확인'}</button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* 제출할 것이 없을 때도 자리를 비우지 않는다 — 종전엔 배너가 통째로 사라져
          이 화면이 제출하는 곳이라는 표시조차 남지 않았다(제출 직후 실측).
          비활성 버튼을 남겨 다음에 무엇을 하는 자리인지 계속 보이게 한다. */}
      {!submittable && (
        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-gray-200 bg-gray-50 p-4">
          <div className="min-w-0 flex-1">
            {round && round.sentCount > 0 ? (
              <>
                <p className="text-sm font-semibold text-green-700">✓ 제출 완료</p>
                <p className="text-xs text-gray-500">
                  {round.label} <b>{round.sentCount}건 · {round.sentAmount.toLocaleString()}원</b>을 본사에 제출했습니다 —
                  본사 검토 후 승인됩니다. 새로 입력한 항목이 생기면 여기에서 제출합니다.
                </p>
              </>
            ) : (
              <>
                <p className="text-sm font-semibold text-gray-600">제출할 항목이 없습니다</p>
                <p className="text-xs text-gray-500">
                  비용을 입력하면 {round ? `${round.label} 전체를` : '작성중인 항목을'} 여기에서 한 번에 본사로 제출합니다.
                </p>
              </>
            )}
          </div>
          <button type="button" disabled
            className="flex items-center gap-2 rounded-lg bg-gray-300 px-4 py-2 text-sm font-semibold text-white">
            <Send className="h-4 w-4" />
            본사 제출
          </button>
        </div>
      )}

      {expenses.length === 0 && (
        <div className="rounded-xl border border-dashed border-gray-300 py-16 text-center">
          <p className="text-gray-400">이 달에 입력된 비용이 없습니다.{round && round.draftCount > 0 ? ' (회차의 다른 달에 작성중 항목이 있습니다 — 월 필터를 바꿔 확인하세요)' : ''}</p>
        </div>
      )}

      {/* 목록 */}
      {expenses.length > 0 && (
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
                            href={receiptHref(url)}
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
                  {(expense.status === 'draft' || expense.status === 'rejected') && (
                    deleteConfirmId === expense.id ? (
                      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2">
                        <span className="text-xs text-red-700">
                          <b>{getSubLabel(expense.category, expense.subcategory)} {expense.amount.toLocaleString()}원</b>을 삭제하면 목록·정산에서 빠집니다. 삭제할까요?
                        </span>
                        <button
                          onClick={() => handleDelete(expense.id)}
                          disabled={isPending}
                          className="flex items-center gap-1 rounded-lg bg-red-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-red-700 disabled:opacity-50"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                          {isPending ? '삭제 중...' : '삭제'}
                        </button>
                        <button
                          onClick={() => setDeleteConfirmId(null)}
                          className="rounded-lg border border-gray-300 bg-white px-2.5 py-1 text-xs text-gray-700 hover:bg-gray-50"
                        >취소</button>
                      </div>
                    ) : (
                      <button
                        onClick={() => setDeleteConfirmId(expense.id)}
                        disabled={isPending}
                        className="flex items-center gap-1 text-xs text-red-500 hover:text-red-700"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                        {expense.status === 'rejected' ? '삭제 후 재입력' : '삭제'}
                      </button>
                    )
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
      )}
    </div>
  )
}
