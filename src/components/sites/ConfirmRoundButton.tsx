'use client'

import { useState, useTransition } from 'react'
import { Button } from '@/components/ui/Button'
import { confirmSettlementRound } from '@/actions/settlementRounds'

interface ConfirmRoundButtonProps {
  siteId: string
  roundId: string
  roundNo: number
  /** 회차 기간 내 미제출 임시저장(draft) 현황 — 확정은 제출·승인분만 편입하므로 사전에 경고한다 */
  unsubmittedCount?: number
  unsubmittedAmount?: number
}

export function ConfirmRoundButton({ siteId, roundId, roundNo, unsubmittedCount = 0, unsubmittedAmount = 0 }: ConfirmRoundButtonProps) {
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
      {/* 확정 직전 안전망 — 미제출분은 편입되지 않아 그대로 삭감으로 이어진다 */}
      {unsubmittedCount > 0 && (
        <div className="rounded-lg border border-red-300 bg-red-50 p-3 text-xs text-red-700">
          ⚠️ 현장이 아직 제출하지 않은 임시저장 항목 <b>{unsubmittedCount}건 · {unsubmittedAmount.toLocaleString()}원</b>이
          있습니다 — 지금 확정하면 이 금액은 <b>이번 회차 정산서에서 빠집니다</b>(발주청 미청구·삭감).
          현장에 제출을 요청한 뒤 확정하는 것을 권장합니다.
        </div>
      )}
      {error && <p className="text-xs text-red-600">{error}</p>}
      <div className="flex gap-2">
        <Button variant="secondary" size="sm" onClick={() => setConfirming(false)}>취소</Button>
        <Button size="sm" loading={isPending} onClick={handleConfirm}>확정</Button>
      </div>
    </div>
  )
}
