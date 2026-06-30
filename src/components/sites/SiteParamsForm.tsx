'use client'

import { useState, useActionState } from 'react'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { Button } from '@/components/ui/Button'
import type { SiteParameters } from '@/types'

interface SiteParamsFormProps {
  siteId: string
  params?: SiteParameters | null
  action: (formData: FormData) => Promise<{ error: string } | { success: boolean }>
}

const travelGradeOptions = [1, 2, 3, 4, 5].map((n) => ({
  value: String(n),
  label: `${n}등급`,
}))

export function SiteParamsForm({ params, action }: SiteParamsFormProps) {
  const [showToast, setShowToast] = useState(false)
  const [applyCommute, setApplyCommute] = useState(params?.apply_commute_regulation ?? true)

  const [state, formAction, pending] = useActionState(
    async (_: { error: string } | null, formData: FormData) => {
      formData.set('apply_commute_regulation', String(applyCommute))
      const result = await action(formData)
      if ('success' in result) {
        setShowToast(true)
        setTimeout(() => setShowToast(false), 3000)
        return null
      }
      return result
    },
    null
  )

  return (
    <form action={formAction} className="space-y-6">
      {state?.error && (
        <div className="rounded-md bg-red-50 px-4 py-3 text-sm text-red-700">
          {state.error}
        </div>
      )}

      {showToast && (
        <div className="rounded-md bg-green-50 px-4 py-3 text-sm text-green-700">
          설정이 저장되었습니다.
        </div>
      )}

      <section className="space-y-4">
        <h3 className="text-sm font-semibold text-gray-700 border-b pb-2">현장주재비 한도</h3>
        <Input
          label="식대 일 한도 (원/1인·1일)"
          name="meal_allowance_daily_limit"
          type="number"
          required
          min={1}
          defaultValue={params?.meal_allowance_daily_limit ?? 25000}
          hint="PRD 기본값: 25,000원. 초과분은 자동으로 불인정 처리됩니다."
        />
        <Input
          label="복리후생비 월 한도 (원/1인·1월)"
          name="welfare_monthly_limit"
          type="number"
          required
          min={1}
          defaultValue={params?.welfare_monthly_limit ?? 50000}
          hint="PRD 기본값: 50,000원."
        />
      </section>

      <section className="space-y-4">
        <h3 className="text-sm font-semibold text-gray-700 border-b pb-2">여비 기준</h3>
        <Select
          label="공무원 여비규정 등급"
          name="travel_grade"
          options={travelGradeOptions}
          defaultValue={String(params?.travel_grade ?? 3)}
          required
        />
        <div className="flex items-center gap-3">
          <input
            id="apply_commute_regulation"
            type="checkbox"
            checked={applyCommute}
            onChange={(e) => setApplyCommute(e.target.checked)}
            className="h-4 w-4 rounded border-gray-300 text-blue-600"
          />
          <label htmlFor="apply_commute_regulation" className="text-sm text-gray-700">
            상주기술인 교통비에 공무원 여비규정 적용
          </label>
        </div>
      </section>

      <section className="space-y-4">
        <h3 className="text-sm font-semibold text-gray-700 border-b pb-2">통신비 규칙</h3>
        <div className="flex items-center gap-3 rounded-md bg-gray-50 p-3">
          <input type="checkbox" checked disabled className="h-4 w-4 rounded border-gray-300" />
          <div>
            <p className="text-sm font-medium text-gray-700">개인 휴대폰 통신비 불인정</p>
            <p className="text-xs text-gray-500">법령 기준 고정 규칙으로 변경 불가합니다.</p>
          </div>
        </div>
      </section>

      <section className="space-y-4">
        <h3 className="text-sm font-semibold text-gray-700 border-b pb-2">비고</h3>
        <textarea
          name="notes"
          rows={3}
          defaultValue={params?.notes ?? ''}
          placeholder="계약 특이사항 등 메모를 입력하세요"
          className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
      </section>

      <div className="flex justify-end pt-2">
        <Button type="submit" loading={pending}>설정 저장</Button>
      </div>
    </form>
  )
}
