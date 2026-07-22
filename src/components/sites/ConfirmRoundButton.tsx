'use client'

import { useState, useTransition } from 'react'
import { Button } from '@/components/ui/Button'
import { confirmSettlementRound } from '@/actions/settlementRounds'

interface ConfirmRoundButtonProps {
  siteId: string
  roundId: string
  roundNo: number
}

export function ConfirmRoundButton({ siteId, roundId, roundNo }: ConfirmRoundButtonProps) {
  const [confirming, setConfirming] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()

  function handleConfirm() {
    setError(null)
    startTransition(async () => {
      const result = await confirmSettlementRound(siteId, roundId)
      if (result && 'error' in result) setError(result.error as string)
      else setConfirming(false)
    })
  }

  if (!confirming) {
    return (
      <div>
        <Button onClick={() => setConfirming(true)}>{roundNo}회차 정산 확정</Button>
        {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
      </div>
    )
  }

  return (
    <div className="rounded-lg border border-blue-200 bg-blue-50 p-4 space-y-3">
      <p className="text-sm font-semibold text-blue-800">
        {roundNo}회차를 이 금액으로 확정하시겠습니까?
      </p>
      <p className="text-xs text-blue-600">
        확정 후에는 이 회차에 포함된 지출 건을 수정·삭제할 수 없습니다.
      </p>
      {error && <p className="text-xs text-red-600">{error}</p>}
      <div className="flex gap-2">
        <Button variant="secondary" size="sm" onClick={() => setConfirming(false)}>취소</Button>
        <Button size="sm" loading={isPending} onClick={handleConfirm}>확정</Button>
      </div>
    </div>
  )
}
