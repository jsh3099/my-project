'use client'

import { useActionState } from 'react'
import Link from 'next/link'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { Button } from '@/components/ui/Button'
import type { Site } from '@/types'

interface SiteFormProps {
  site?: Site
  action: (formData: FormData) => Promise<{ error: string } | void>
}

const statusOptions = [
  { value: 'active', label: '진행중' },
  { value: 'completed', label: '완료' },
  { value: 'suspended', label: '중단' },
]

export function SiteForm({ site, action }: SiteFormProps) {
  const [state, formAction, pending] = useActionState(
    async (_: { error: string } | null, formData: FormData) => {
      const result = await action(formData)
      return result ?? null
    },
    null
  )

  return (
    <form action={formAction} className="space-y-5">
      {state?.error && (
        <div className="rounded-md bg-red-50 px-4 py-3 text-sm text-red-700">
          {state.error}
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

      <div className="grid grid-cols-2 gap-4">
        <Input
          label="계약금액 (원)"
          name="contract_amount"
          type="number"
          required
          defaultValue={site?.contract_amount}
          placeholder="0"
          min={1}
        />
        <Input
          label="직접경비 예산 (원)"
          name="direct_expense_budget"
          type="number"
          required
          defaultValue={site?.direct_expense_budget}
          placeholder="0"
          min={1}
        />
      </div>

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
        <Button type="submit" loading={pending}>
          {site ? '수정 저장' : '현장 등록'}
        </Button>
      </div>
    </form>
  )
}
