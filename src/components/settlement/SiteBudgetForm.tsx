'use client'

import { useMemo, useState, useTransition } from 'react'
import { ChevronDown, ChevronUp } from 'lucide-react'
import { EXPENSE_CATEGORY_LABELS, type ExpenseCategory } from '@/lib/constants'

interface Props {
  siteId: string
  /** category → amount (기존 저장값) */
  budgets: Partial<Record<ExpenseCategory, number>>
  action: (formData: FormData) => Promise<{ error: string } | { success: boolean }>
}

const BUDGET_CATEGORIES = Object.entries(EXPENSE_CATEGORY_LABELS) as [ExpenseCategory, string][]

function formatKRW(n: number) {
  return n.toLocaleString('ko-KR') + '원'
}

/** 항목별 계상금액 입력 카드 — 계약 내역서의 직접경비 항목별 금액을 기재한다 */
export function SiteBudgetForm({ siteId, budgets, action }: Props) {
  const hasAny = Object.values(budgets).some((v) => (v ?? 0) > 0)
  const [open, setOpen] = useState(!hasAny)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [isPending, startTransition] = useTransition()
  const [inputs, setInputs] = useState<Record<ExpenseCategory, string>>(() => {
    const init = {} as Record<ExpenseCategory, string>
    for (const [key] of BUDGET_CATEGORIES) {
      const v = budgets[key]
      init[key] = v && v > 0 ? v.toLocaleString('ko-KR') : ''
    }
    return init
  })

  const sum = useMemo(
    () => BUDGET_CATEGORIES.reduce((s, [key]) => s + (parseInt(inputs[key].replace(/,/g, ''), 10) || 0), 0),
    [inputs],
  )

  function handleChange(key: ExpenseCategory, value: string) {
    const raw = value.replace(/[^0-9]/g, '')
    setInputs((prev) => ({ ...prev, [key]: raw ? parseInt(raw, 10).toLocaleString('ko-KR') : '' }))
    setSaved(false)
  }

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const formData = new FormData()
    for (const [key] of BUDGET_CATEGORIES) {
      formData.set(`budget_${key}`, inputs[key].replace(/,/g, ''))
    }
    setError(null)
    startTransition(async () => {
      const result = await action(formData)
      if ('error' in result) {
        setError(result.error)
      } else {
        setSaved(true)
      }
    })
  }

  return (
    <div className="rounded-lg border border-gray-200 bg-white">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between px-6 py-4 text-left"
      >
        <div>
          <span className="text-sm font-semibold text-gray-800">항목별 계상금액 입력</span>
          <span className="ml-2 text-xs text-gray-400">
            {hasAny || sum > 0 ? `합계 ${formatKRW(sum)}` : '미입력 — 입력해야 사용액·잔액 추적이 시작됩니다'}
          </span>
        </div>
        {open ? <ChevronUp className="h-4 w-4 text-gray-400" /> : <ChevronDown className="h-4 w-4 text-gray-400" />}
      </button>

      {open && (
        <form onSubmit={handleSubmit} className="space-y-4 border-t border-gray-100 px-6 py-4">
          <p className="text-xs text-gray-500">
            계약 내역서(산출내역서)의 직접경비 항목별 계상금액을 그대로 기재하세요.
            해당 없는 항목은 비워두면 됩니다. (배치표 기반 산출은 시스템이 계산하지 않습니다 — 내역서 금액을 직접 입력)
          </p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {BUDGET_CATEGORIES.map(([key, label]) => (
              <div key={key}>
                <label className="mb-1 block text-xs font-medium text-gray-600">{label}</label>
                <div className="relative">
                  <input
                    type="text"
                    inputMode="numeric"
                    value={inputs[key]}
                    onChange={(e) => handleChange(key, e.target.value)}
                    placeholder="0"
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 pr-8 text-right text-sm focus:border-blue-500 focus:outline-none"
                  />
                  <span className="absolute right-3 top-2 text-sm text-gray-400">원</span>
                </div>
              </div>
            ))}
          </div>
          <div className="flex items-center justify-between">
            <p className="text-sm text-gray-600">
              합계(계상총액): <span className="font-semibold text-gray-900">{formatKRW(sum)}</span>
              {sum > 0 && <span className="ml-1 text-xs text-gray-400">— 저장 시 현장 계상총액이 이 합계로 설정됩니다</span>}
            </p>
            <button
              type="submit"
              disabled={isPending}
              className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {isPending ? '저장 중...' : '저장'}
            </button>
          </div>
          {error && <p className="text-sm text-red-600">{error}</p>}
          {saved && <p className="text-sm text-green-600">저장되었습니다. 아래 현황이 새 계상금액 기준으로 갱신됩니다.</p>}
        </form>
      )}
    </div>
  )
}
