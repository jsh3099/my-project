'use client'

import { useState, useTransition } from 'react'
import { calcCommuteCost, saveMyTransportInfo, type CommuteCalcResult } from '@/actions/commute'
import { VEHICLE_FUEL_TYPE_LABELS, FUEL_EFFICIENCY, type VehicleFuelType } from '@/lib/constants'

interface Props {
  siteAddress: string
  isOwnRow: boolean
  defaultHomeAddress?: string | null
  defaultFuelType?: string | null
  onApply: (dailyAmount: number) => void
}

function formatKRW(n: number) {
  return n.toLocaleString('ko-KR') + '원'
}

export function CommuteCalcPanel({ siteAddress, isOwnRow, defaultHomeAddress, defaultFuelType, onApply }: Props) {
  const [homeAddress, setHomeAddress] = useState(defaultHomeAddress ?? '')
  const [fuelType, setFuelType] = useState<VehicleFuelType>((defaultFuelType as VehicleFuelType) ?? 'gasoline')
  const [fuelPrice, setFuelPrice] = useState('')
  const [result, setResult] = useState<CommuteCalcResult | null>(null)
  const [error, setError] = useState('')
  const [isPending, startTransition] = useTransition()
  const [saved, setSaved] = useState(false)

  function handleCalc() {
    setError('')
    setResult(null)
    if (!siteAddress) { setError('현장 주소가 등록되어 있지 않습니다. 현장 관리에서 먼저 주소를 입력하세요.'); return }
    const formData = new FormData()
    formData.set('home_address', homeAddress)
    formData.set('site_address', siteAddress)
    formData.set('fuel_type', fuelType)
    formData.set('fuel_price', fuelPrice.replace(/,/g, ''))
    startTransition(async () => {
      const res = await calcCommuteCost(formData)
      if ('error' in res) setError(res.error)
      else setResult(res.data)
    })
  }

  function handleSaveMyInfo() {
    const formData = new FormData()
    formData.set('home_address', homeAddress)
    formData.set('vehicle_fuel_type', fuelType)
    startTransition(async () => {
      const res = await saveMyTransportInfo(formData)
      if (!('error' in res)) { setSaved(true); setTimeout(() => setSaved(false), 2000) }
    })
  }

  return (
    <div className="border-t border-green-100 bg-green-50/40 px-4 py-3 space-y-2.5 text-sm">
      <p className="text-xs font-semibold text-gray-600">🚗 자차 교통비 산출 (거리 × 유가 ÷ 연비, 공무원보수 등의 업무지침 기준)</p>

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <div>
          <label className="mb-0.5 block text-xs text-gray-500">자택주소</label>
          <input
            type="text" value={homeAddress} onChange={(e) => setHomeAddress(e.target.value)}
            placeholder="예: 대전시 유성구 봉명로 48"
            className="w-full rounded border border-gray-300 px-2 py-1.5 text-sm focus:border-blue-500 focus:outline-none"
          />
        </div>
        <div>
          <label className="mb-0.5 block text-xs text-gray-500">현장주소</label>
          <input type="text" value={siteAddress} readOnly
            className="w-full rounded border border-gray-200 bg-gray-100 px-2 py-1.5 text-sm text-gray-500" />
        </div>
        <div>
          <label className="mb-0.5 block text-xs text-gray-500">차종(유종)</label>
          <select value={fuelType} onChange={(e) => setFuelType(e.target.value as VehicleFuelType)}
            className="w-full rounded border border-gray-300 px-2 py-1.5 text-sm focus:border-blue-500 focus:outline-none">
            {Object.entries(VEHICLE_FUEL_TYPE_LABELS).map(([v, label]) => (
              <option key={v} value={v}>{label} ({FUEL_EFFICIENCY[v as VehicleFuelType].unit} {FUEL_EFFICIENCY[v as VehicleFuelType].value})</option>
            ))}
          </select>
        </div>
        <div>
          <label className="mb-0.5 block text-xs text-gray-500">유가 ({FUEL_EFFICIENCY[fuelType].priceUnit}, opinet.co.kr 참고)</label>
          <input
            type="text" inputMode="numeric" value={fuelPrice}
            onChange={(e) => { const r = e.target.value.replace(/[^0-9]/g, ''); setFuelPrice(r ? parseInt(r).toLocaleString('ko-KR') : '') }}
            placeholder="예: 1,650"
            className="w-full rounded border border-gray-300 px-2 py-1.5 text-sm focus:border-blue-500 focus:outline-none"
          />
        </div>
      </div>

      <div className="flex items-center gap-2">
        <button type="button" onClick={handleCalc} disabled={isPending}
          className="rounded-md bg-green-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-green-700 disabled:opacity-50">
          {isPending ? '계산 중...' : '경로 조회·계산'}
        </button>
        {isOwnRow && (
          <button type="button" onClick={handleSaveMyInfo}
            className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-xs text-gray-600 hover:bg-gray-50">
            {saved ? '저장됨 ✓' : '내 정보로 저장'}
          </button>
        )}
      </div>

      {error && <p className="text-xs text-red-600">{error}</p>}

      {result && (
        <div className="rounded-lg border border-green-200 bg-white p-3 space-y-1">
          <div className="flex justify-between text-xs text-gray-600">
            <span>거리 (편도 {result.distanceOneWayKm.toFixed(1)}km × 왕복)</span>
            <span>{result.distanceRoundTripKm.toFixed(1)}km</span>
          </div>
          <div className="flex justify-between text-xs text-gray-600">
            <span>통행료 (왕복)</span>
            <span>{formatKRW(result.tollRoundTrip)}</span>
          </div>
          <div className="flex justify-between text-xs text-gray-600">
            <span>연료비</span>
            <span>{formatKRW(result.fuelCost)}</span>
          </div>
          <div className="flex justify-between border-t pt-1 text-sm font-semibold text-green-700">
            <span>1일 교통비 합계</span>
            <span>{formatKRW(result.total)}</span>
          </div>
          <button
            type="button"
            onClick={() => onApply(result.total)}
            className="mt-1 w-full rounded-md bg-blue-600 py-1.5 text-xs font-medium text-white hover:bg-blue-700"
          >
            이 금액을 교통비(1일)에 적용
          </button>
        </div>
      )}
    </div>
  )
}
