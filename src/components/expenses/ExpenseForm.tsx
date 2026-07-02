'use client'

import { useRef, useState, useTransition } from 'react'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { Button } from '@/components/ui/Button'
import { RequirementGuide } from '@/components/expenses/RequirementGuide'
import { LimitWarning } from '@/components/expenses/LimitWarning'
import { EXPENSE_CATEGORIES, LIMIT_RULES } from '@/lib/expense-categories'
import { createExpense } from '@/actions/expenses'
import type { Site } from '@/types'

interface ExpenseFormProps {
  sites: Site[]
  defaultSiteId?: string
  defaultYear: number
  defaultMonth: number
}

const categoryOptions = Object.keys(EXPENSE_CATEGORIES).map((c) => ({ value: c, label: c }))

export function ExpenseForm({ sites, defaultSiteId, defaultYear, defaultMonth }: ExpenseFormProps) {
  const formRef = useRef<HTMLFormElement>(null)
  const [error, setError] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()
  const [selectedCategory, setSelectedCategory] = useState('')
  const [selectedSubcategory, setSelectedSubcategory] = useState('')
  const [amount, setAmount] = useState(0)

  const subcategoryOptions = selectedCategory
    ? EXPENSE_CATEGORIES[selectedCategory].map((s) => ({ value: s, label: s }))
    : []

  const siteOptions = sites.map((s) => ({ value: s.id, label: s.name }))
  const hasLimit = selectedSubcategory && LIMIT_RULES[selectedSubcategory]

  function submit(submissionStatus: 'draft' | 'submitted') {
    if (!formRef.current) return
    const formData = new FormData(formRef.current)
    setError(null)
    startTransition(async () => {
      const result = await createExpense(submissionStatus, formData)
      if (result && 'error' in result) {
        setError(result.error as string)
      } else if (result?.success && submissionStatus === 'draft') {
        formRef.current?.reset()
        setSelectedCategory('')
        setSelectedSubcategory('')
        setAmount(0)
      }
    })
  }

  return (
    <form ref={formRef} onSubmit={(e) => e.preventDefault()} className="space-y-5">
      {error && (
        <div className="rounded-md bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
      )}

      <input type="hidden" name="year" value={defaultYear} />
      <input type="hidden" name="month" value={defaultMonth} />

      <Select
        label="현장"
        name="site_id"
        options={siteOptions}
        defaultValue={defaultSiteId}
        placeholder="현장을 선택하세요"
        required
      />

      <div className="grid grid-cols-2 gap-4">
        <Select
          label="비목 (대분류)"
          name="category"
          options={categoryOptions}
          placeholder="비목 선택"
          required
          value={selectedCategory}
          onChange={(e) => {
            setSelectedCategory(e.target.value)
            setSelectedSubcategory('')
          }}
        />
        <Select
          label="세부항목"
          name="subcategory"
          options={subcategoryOptions}
          placeholder={selectedCategory ? '세부항목 선택' : '비목 먼저 선택'}
          required
          disabled={!selectedCategory}
          value={selectedSubcategory}
          onChange={(e) => setSelectedSubcategory(e.target.value)}
        />
      </div>

      {selectedSubcategory && <RequirementGuide subcategory={selectedSubcategory} />}

      <div className="grid grid-cols-2 gap-4">
        <Input
          label="금액 (원)"
          name="amount"
          type="number"
          required
          min={1}
          placeholder="0"
          onChange={(e) => setAmount(Number(e.target.value))}
        />
        <Input
          label="발생일"
          name="expense_date"
          type="date"
          required
        />
      </div>

      {hasLimit && amount > 0 && (
        <LimitWarning subcategory={selectedSubcategory} amount={amount} accumulated={0} />
      )}

      <Input
        label="메모"
        name="memo"
        placeholder="특이사항 입력 (선택사항)"
      />

      <div className="flex justify-end gap-3 pt-2">
        <Button
          type="button"
          variant="secondary"
          loading={isPending}
          onClick={() => submit('draft')}
        >
          임시저장
        </Button>
        <Button
          type="button"
          loading={isPending}
          onClick={() => submit('submitted')}
        >
          최종제출
        </Button>
      </div>
    </form>
  )
}
