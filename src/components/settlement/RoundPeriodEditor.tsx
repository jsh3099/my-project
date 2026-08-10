'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/Button'
import { updateSettlementRoundPeriod, createSettlementRound } from '@/actions/settlementRounds'

interface RoundPeriodEditorProps {
  siteId: string
  /** 진행 중 회차 — 없으면(확정 직후 등) 입력 시 다음 회차를 새로 시작한다 */
  round: { id: string; round_no: number; period_start: string; period_end: string } | null
  /** round가 null일 때 새로 시작할 회차 번호 */
  nextRoundNo: number
}

// 기성기간 패널 — 항상 펼쳐진 한 줄 입력(연·월·일).
// 진행 중 회차가 있으면 그 기간을 보여주고 고치면 수정,
// 없으면 빈 입력이 보이고 저장하면 다음 회차가 그 기간으로 시작된다.
// 기간 축소·겹침 경고가 있으면 한 번 더 확인받고 저장한다. 확정 회차는 건드리지 않는다.
export function RoundPeriodEditor({ siteId, round, nextRoundNo }: RoundPeriodEditorProps) {
  const router = useRouter()
  const [startDate, setStartDate] = useState(round?.period_start ?? '')
  const [endDate, setEndDate] = useState(round?.period_end ?? '')
  const [error, setError] = useState<string | null>(null)
  const [warnings, setWarnings] = useState<string[] | null>(null)
  const [saved, setSaved] = useState(false)
  const [isPending, startTransition] = useTransition()

  const roundNo = round ? round.round_no : nextRoundNo
  const dirty = round ? startDate !== round.period_start || endDate !== round.period_end : true

  function submit(confirmed: boolean) {
    setError(null)
    setSaved(false)
    if (!startDate || !endDate) {
      setError('기성기간 시작일과 종료일을 입력하세요.')
      return
    }
    const fd = new FormData()
    fd.set('period_start', startDate)
    fd.set('period_end', endDate)
    if (confirmed) fd.set('confirm', '1')
    startTransition(async () => {
      const result = round
        ? await updateSettlementRoundPeriod(siteId, round.id, fd)
        : await createSettlementRound(siteId, fd)
      if ('error' in result) {
        setWarnings(null)
        setError(result.error)
      } else if ('needsConfirm' in result && result.needsConfirm) {
        setWarnings(result.warnings)
      } else {
        setWarnings(null)
        setSaved(true)
        router.refresh()
      }
    })
  }

  return (
    <div className="w-full space-y-2 rounded-lg border border-gray-200 bg-gray-50/60 p-3">
      <div className="flex flex-wrap items-end gap-3">
        <span className="pb-2 text-sm font-medium text-gray-800">기성기간</span>
        <div>
          <label className="mb-1 block text-xs text-gray-500">시작일</label>
          <input
            type="date"
            value={startDate}
            onChange={(e) => {
              setStartDate(e.target.value)
              setWarnings(null)
              setSaved(false)
            }}
            className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm focus:outline-none"
          />
        </div>
        <div>
          <label className="mb-1 block text-xs text-gray-500">종료일</label>
          <input
            type="date"
            value={endDate}
            onChange={(e) => {
              setEndDate(e.target.value)
              setWarnings(null)
              setSaved(false)
            }}
            className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm focus:outline-none"
          />
        </div>
        {!warnings && (
          <Button type="button" onClick={() => submit(false)} loading={isPending} disabled={!dirty}>
            {round ? '저장' : `${roundNo}회차 시작`}
          </Button>
        )}
        {saved && <span className="pb-2 text-sm text-green-700">✓ 저장되었습니다</span>}
      </div>
      {!round && (
        <p className="text-xs text-gray-500">
          진행 중인 회차가 없습니다 — 기성기간을 입력하면 {roundNo}회차가 시작되고, 그 기간의 증빙을 첨부할 수 있습니다.
        </p>
      )}
      {error && <div className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}

      {/* 경고 확인 단계 — 축소로 기간 밖에 남는 기록·회차 겹침 */}
      {warnings && (
        <div className="space-y-2 rounded-lg border border-amber-300 bg-amber-50 p-3">
          <p className="text-sm font-medium text-amber-800">저장 전에 확인하세요:</p>
          <ul className="list-inside list-disc space-y-0.5 text-sm text-amber-700">
            {warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
          <div className="flex gap-2 pt-1">
            <button
              type="button"
              onClick={() => setWarnings(null)}
              className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-600 hover:bg-gray-50"
            >
              돌아가기
            </button>
            <Button type="button" onClick={() => submit(true)} loading={isPending}>
              확인했습니다 — 저장
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
