'use client'

import { useTransition, useState } from 'react'
import { Button } from '@/components/ui/Button'
import { submitExpenses } from '@/actions/expenses'

interface SubmitAllButtonProps {
  siteId: string
  year: number
  month: number
}

export function SubmitAllButton({ siteId, year, month }: SubmitAllButtonProps) {
  const [isPending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

  function handleSubmit() {
    setError(null)
    startTransition(async () => {
      const result = await submitExpenses(siteId, year, month)
      if (result && 'error' in result) setError(result.error as string)
    })
  }

  return (
    <div>
      <Button variant="secondary" loading={isPending} onClick={handleSubmit}>
        전체 최종제출
      </Button>
      {error && <p className="text-xs text-red-600 mt-1">{error}</p>}
    </div>
  )
}
