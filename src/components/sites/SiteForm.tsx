'use client'

import { useMemo, useState, useTransition } from 'react'
import Link from 'next/link'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { Button } from '@/components/ui/Button'
import { EXPENSE_CATEGORY_LABELS, type ExpenseCategory } from '@/lib/constants'
import type { Site } from '@/types'

interface SiteFormProps {
  site?: Site
  /** 항목별 계상금액 (site_expense_budgets) — category → amount */
  budgets?: Partial<Record<ExpenseCategory, number>>
  action: (formData: FormData) => Promise<{ error: string } | void>
}

const statusOptions = [
  { value: 'active', label: '진행중' },
  { value: 'completed', label: '완료' },
  { value: 'suspended', label: '중단' },
]

const BUDGET_CATEGORIES = Object.entries(EXPENSE_CATEGORY_LABELS) as [ExpenseCategory, string][]

function formatKRW(n: number) {
  return n.toLocaleString('ko-KR') + '원'
}

export function SiteForm({ site, budgets, action }: SiteFormProps) {
  const [error, setError] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()
  const [totalInput, setTotalInput] = useState(
    site?.direct_expense_budget ? String(site.direct_expense_budget) : '',
  )
  const [budgetInputs, setBudgetInputs] = useState<Record<ExpenseCategory, string>>(() => {
    const init = {} as Record<ExpenseCategory, string>
    for (const [key] of BUDGET_CATEGORIES) {
      const v = budgets?.[key]
      init[key] = v && v > 0 ? String(v) : ''
    }
    return init
  })

  const budgetSum = useMemo(
    () => BUDGET_CATEGORIES.reduce((s, [key]) => s + (parseInt(budgetInputs[key], 10) || 0), 0),
    [budgetInputs],
  )
  const hasItemBudgets = budgetSum > 0

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const formData = new FormData(e.currentTarget)
    setError(null)
    startTransition(async () => {
      const result = await action(formData)
      if (result && 'error' in result) setError(result.error)
    })
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      {error && (
        <div className="rounded-md bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      <Input
        label="현장명"
        name="name"
        required
        defaultValue={site?.name}
        placeholder="예: 한강대교 CM 현장"
      />
      <Input
        label="발주처"
        name="client_name"
        required
        defaultValue={site?.client_name}
        placeholder="예: 서울특별시"
      />
      <Input
        label="현장 주소"
        name="address"
        defaultValue={site?.address ?? ''}
        placeholder="예: 충북 청주시 상당구 문화동 89 (자차 교통비 자동산출에 사용)"
      />

      <div className="grid grid-cols-2 gap-4">
        <Input
          label="계약 시작일"
          name="contract_start"
          type="date"
          required
          defaultValue={site?.contract_start}
        />
        <Input
          label="계약 종료일"
          name="contract_end"
          type="date"
          required
          defaultValue={site?.contract_end}
        />
      </div>

      <Input
        label="계약금액 (원)"
        name="contract_amount"
        type="number"
        required
        defaultValue={site?.contract_amount}
        placeholder="0"
        min={1}
      />

      {/* 항목별 직접경비 계상금액 — 내역서(산출내역서)의 직접경비 항목별 금액 */}
      <fieldset className="rounded-lg border border-gray-200 p-4">
        <legend className="px-1 text-sm font-medium text-gray-700">
          직접경비 계상금액 (항목별)
        </legend>
        <p className="mb-3 text-xs text-gray-500">
          계약 내역서상 직접경비 항목별 계상금액을 그대로 입력하세요.
          해당 없는 항목은 비워두세요. (배치표 기반 산출은 시스템이 계산하지 않습니다)
        </p>
        <div className="grid grid-cols-2 gap-4">
          {BUDGET_CATEGORIES.map(([key, label]) => (
            <Input
              key={key}
              label={label}
              name={`budget_${key}`}
              type="number"
              min={0}
              placeholder="0"
              value={budgetInputs[key]}
              onChange={(e) =>
                setBudgetInputs((prev) => ({ ...prev, [key]: e.target.value }))
              }
            />
          ))}
        </div>
        <p className="mt-3 text-sm text-gray-600">
          항목 합계: <span className="font-semibold text-gray-900">{formatKRW(budgetSum)}</span>
          {hasItemBudgets && ' — 저장 시 직접경비 예산(총액)이 이 합계로 설정됩니다.'}
        </p>
      </fieldset>

      <Input
        label="직접경비 예산 · 계상총액 (원)"
        name="direct_expense_budget"
        type="number"
        required
        placeholder="0"
        min={1}
        readOnly={hasItemBudgets}
        value={hasItemBudgets ? String(budgetSum) : totalInput}
        onChange={(e) => setTotalInput(e.target.value)}
      />

      <Select
        label="현장 상태"
        name="status"
        options={statusOptions}
        defaultValue={site?.status ?? 'active'}
      />

      <div className="flex justify-end gap-3 pt-2">
        <Link href="/admin/sites">
          <Button type="button" variant="secondary">취소</Button>
        </Link>
        <Button type="submit" loading={isPending}>
          {site ? '수정 저장' : '현장 등록'}
        </Button>
      </div>
    </form>
  )
}
