'use client'

import { useMemo, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Check, X, Receipt, ChevronDown, ChevronUp } from 'lucide-react'
import { EXPENSE_CATEGORY_LABELS, EXPENSE_SUBCATEGORIES, type ExpenseCategory } from '@/lib/constants'
import { approveExpenses, rejectExpense } from '@/actions/review'
import { receiptHref } from '@/lib/storage/receipts'

export interface ReviewExpense {
  id: string
  siteId: string
  siteName: string
  category: string
  subcategory: string
  amount: number
  overLimitAmount: number
  isOverLimit: boolean
  expenseDate: string
  yearMonth: string
  periodStart: string | null
  periodEnd: string | null
  targetUserName: string | null
  memo: string | null
  receiptUrls: string[]
  submitterName: string
}

interface Props {
  expenses: ReviewExpense[]
}

function getSubLabel(category: string, subcategory: string) {
  const subs = EXPENSE_SUBCATEGORIES[category as ExpenseCategory] ?? []
  return subs.find((s) => s.value === subcategory)?.label ?? subcategory
}

function formatKRW(n: number) {
  return n.toLocaleString('ko-KR') + '원'
}

export function ReviewList({ expenses }: Props) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [rejectingId, setRejectingId] = useState<string | null>(null)
  const [rejectReason, setRejectReason] = useState('')
  const [message, setMessage] = useState<{ type: 'ok' | 'error'; text: string } | null>(null)

  const bySite = useMemo(() => {
    const m = new Map<string, { siteName: string; items: ReviewExpense[] }>()
    for (const e of expenses) {
      const entry = m.get(e.siteId) ?? { siteName: e.siteName, items: [] }
      entry.items.push(e)
      m.set(e.siteId, entry)
    }
    return [...m.entries()]
  }, [expenses])

  const handleApprove = (ids: string[]) => {
    startTransition(async () => {
      const result = await approveExpenses(ids)
      if (result.error) setMessage({ type: 'error', text: result.error })
      else {
        setMessage({ type: 'ok', text: `${result.count}건이 승인됐습니다.` })
        router.refresh()
      }
    })
  }

  const handleReject = (id: string) => {
    startTransition(async () => {
      const result = await rejectExpense(id, rejectReason)
      if (result.error) setMessage({ type: 'error', text: result.error })
      else {
        setMessage({ type: 'ok', text: '반려 처리됐습니다. 현장 직원에게 사유가 표시됩니다.' })
        setRejectingId(null)
        setRejectReason('')
        router.refresh()
      }
    })
  }

  if (expenses.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-gray-300 bg-white py-16 text-center">
        <p className="text-gray-400">검토 대기 중인 제출 건이 없습니다.</p>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {message && (
        <div
          className={`rounded-lg border p-3 text-sm ${
            message.type === 'ok'
              ? 'border-green-200 bg-green-50 text-green-700'
              : 'border-red-200 bg-red-50 text-red-700'
          }`}
        >
          {message.text}
        </div>
      )}

      {bySite.map(([siteId, group]) => {
        const total = group.items.reduce((s, e) => s + (e.amount - e.overLimitAmount), 0)
        return (
          <div key={siteId} className="overflow-hidden rounded-xl border border-gray-200 bg-white">
            <div className="flex items-center justify-between border-b border-gray-200 bg-gray-50 px-5 py-3">
              <div>
                <p className="text-sm font-semibold text-gray-800">{group.siteName}</p>
                <p className="text-xs text-gray-500">
                  {group.items.length}건 · 인정금액 합계 {formatKRW(total)}
                </p>
              </div>
              <button
                onClick={() => handleApprove(group.items.map((e) => e.id))}
                disabled={isPending}
                className="flex items-center gap-1.5 rounded-lg bg-green-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-green-700 disabled:opacity-50"
              >
                <Check className="h-3.5 w-3.5" />
                전체 승인
              </button>
            </div>

            <div className="divide-y divide-gray-100">
              {group.items.map((e) => (
                <div key={e.id}>
                  <div className="flex items-center justify-between gap-3 px-5 py-3">
                    <button
                      type="button"
                      className="flex-1 text-left"
                      onClick={() => setExpandedId(expandedId === e.id ? null : e.id)}
                    >
                      <div className="flex items-center gap-2">
                        <p className="text-sm font-medium text-gray-800">
                          {EXPENSE_CATEGORY_LABELS[e.category as ExpenseCategory] ?? e.category}
                          <span className="mx-1 text-gray-400">›</span>
                          <span className="text-gray-500">{getSubLabel(e.category, e.subcategory)}</span>
                        </p>
                        {expandedId === e.id
                          ? <ChevronUp className="h-3.5 w-3.5 text-gray-400" />
                          : <ChevronDown className="h-3.5 w-3.5 text-gray-400" />}
                      </div>
                      <p className="mt-0.5 text-xs text-gray-400">
                        {e.yearMonth} · {e.targetUserName ? `${e.targetUserName} · ` : ''}제출 {e.submitterName}
                      </p>
                    </button>

                    <div className="text-right">
                      <p className={`text-sm font-semibold ${e.isOverLimit ? 'text-red-500' : 'text-gray-900'}`}>
                        {formatKRW(e.amount)}
                      </p>
                      {e.isOverLimit && (
                        <p className="text-xs text-red-400">초과 {formatKRW(e.overLimitAmount)}</p>
                      )}
                    </div>

                    <div className="flex shrink-0 gap-1.5">
                      <button
                        onClick={() => handleApprove([e.id])}
                        disabled={isPending}
                        className="flex items-center gap-1 rounded-lg border border-green-300 bg-green-50 px-2.5 py-1.5 text-xs font-medium text-green-700 hover:bg-green-100 disabled:opacity-50"
                      >
                        <Check className="h-3.5 w-3.5" />
                        승인
                      </button>
                      <button
                        onClick={() => { setRejectingId(rejectingId === e.id ? null : e.id); setRejectReason('') }}
                        disabled={isPending}
                        className="flex items-center gap-1 rounded-lg border border-red-300 bg-red-50 px-2.5 py-1.5 text-xs font-medium text-red-700 hover:bg-red-100 disabled:opacity-50"
                      >
                        <X className="h-3.5 w-3.5" />
                        반려
                      </button>
                    </div>
                  </div>

                  {/* 반려 사유 입력 */}
                  {rejectingId === e.id && (
                    <div className="border-t border-red-100 bg-red-50 px-5 py-3">
                      <p className="mb-2 text-xs font-medium text-red-700">반려 사유 (필수) — 현장 직원에게 그대로 표시됩니다</p>
                      <div className="flex gap-2">
                        <input
                          type="text"
                          value={rejectReason}
                          onChange={(ev) => setRejectReason(ev.target.value)}
                          placeholder="예: 세금계산서 누락 — 첨부 후 재제출 바랍니다"
                          className="flex-1 rounded-lg border border-red-200 bg-white px-3 py-2 text-sm focus:border-red-400 focus:outline-none"
                        />
                        <button
                          onClick={() => handleReject(e.id)}
                          disabled={isPending || !rejectReason.trim()}
                          className="rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white hover:bg-red-700 disabled:opacity-50"
                        >
                          {isPending ? '처리 중...' : '반려 확정'}
                        </button>
                      </div>
                    </div>
                  )}

                  {/* 상세 펼침 */}
                  {expandedId === e.id && (
                    <div className="space-y-2 border-t border-gray-100 bg-gray-50 px-5 py-3 text-sm text-gray-600">
                      <p><span className="font-medium">지출일:</span> {e.expenseDate}{e.periodStart && ` (기간 ${e.periodStart} ~ ${e.periodEnd})`}</p>
                      {e.memo && <p><span className="font-medium">메모:</span> {e.memo}</p>}
                      {e.isOverLimit && (
                        <p className="text-xs text-red-600">한도 초과 {formatKRW(e.overLimitAmount)}은 불인정 처리되어 합계에서 제외됩니다.</p>
                      )}
                      {e.receiptUrls.length > 0 ? (
                        <div className="flex flex-wrap gap-2">
                          {e.receiptUrls.map((url, i) => (
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
                      ) : (
                        <p className="text-xs text-yellow-600">⚠ 첨부된 영수증이 없습니다 — 필수 증빙 누락 여부를 확인하세요.</p>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )
      })}
    </div>
  )
}
