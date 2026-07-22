'use client'

import { useState, useTransition } from 'react'
import { Input } from '@/components/ui/Input'
import { Button } from '@/components/ui/Button'

interface SettlementRoundFormProps {
  nextRoundNo: number
  defaultPeriodStart: string
  action: (formData: FormData) => Promise<{ error: string } | { success: boolean }>
}

export function SettlementRoundForm({ nextRoundNo, defaultPeriodStart, action }: SettlementRoundFormProps) {
  const [error, setError] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const formData = new FormData(e.currentTarget)
    setError(null)
    startTransition(async () => {
      const result = await action(formData)
      if ('error' in result) setError(result.error)
    })
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {error && (
        <div className="rounded-md bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
      )}
      <p className="text-sm text-gray-500">
        <span className="font-semibold text-gray-700">{nextRoundNo}회차</span> 정산 대상 기간을 지정하세요.
      </p>
      <div className="grid grid-cols-2 gap-4">
        <Input label="정산 시작일" name="period_start" type="date" required defaultValue={defaultPeriodStart} />
        <Input label="정산 종료일" name="period_end" type="date" required />
      </div>
      <div className="flex justify-end">
        <Button type="submit" loading={isPending}>{nextRoundNo}회차 시작</Button>
      </div>
    </form>
  )
}
