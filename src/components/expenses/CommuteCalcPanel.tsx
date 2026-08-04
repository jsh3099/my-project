'use client'

import { useState, useTransition } from 'react'
import { calcCommuteCost, saveMyTransportInfo } from '@/actions/commute'
import { getFuelPriceForDate } from '@/actions/fuelPrice'
import { calcCommute } from '@/lib/settlement'
import { VEHICLE_FUEL_TYPE_LABELS, FUEL_EFFICIENCY, type VehicleFuelType } from '@/lib/constants'

// 산출 파라미터 — 부모 행에 적용되고 서버가 동일 값으로 재계산해 commute_calcs에 저장한다
export interface CommuteApplyParams {
  homeAddress: string
  distanceOnewayKm: number
  fuelType: VehicleFuelType
  fuelEfficiency: number
  fuelPrice: number
  fuelPriceDate: string | null
  fuelCostRoundtrip: number
  tollRoundtrip: number
  costPerTrip: number // 1회 왕복비 = 유류비 + 통행료
}

interface Props {
  siteAddress: string
  isOwnRow: boolean
  defaultHomeAddress?: string | null
  defaultFuelType?: string | null
  onApply: (params: CommuteApplyParams) => void
}

function formatKRW(n: number) {
  return n.toLocaleString('ko-KR') + '원'
}

export function CommuteCalcPanel({ siteAddress, isOwnRow, defaultHomeAddress, defaultFuelType, onApply }: Props) {
  const [homeAddress, setHomeAddress] = useState(defaultHomeAddress ?? '')
  const [fuelType, setFuelType] = useState<VehicleFuelType>((defaultFuelType as VehicleFuelType) ?? 'gasoline')
  const [fuelPrice, setFuelPrice] = useState('')
  const [fuelPriceDate, setFuelPriceDate] = useState('')
  const [distanceOneway, setDistanceOneway] = useState('') // 편도 km — 수동입력 or 경로조회로 채움
  const [toll, setToll] = useState('') // 왕복 통행료
  const [error, setError] = useState('')
  const [isPending, startTransition] = useTransition()
  const [saved, setSaved] = useState(false)

  const distNum = parseFloat(distanceOneway) || 0
  const priceNum = parseInt(fuelPrice.replace(/,/g, ''), 10) || 0
  const tollNum = parseInt(toll.replace(/,/g, ''), 10) || 0
  const efficiency = FUEL_EFFICIENCY[fuelType].value

  // 파라미터가 갖춰지면 즉시 미리보기 (서버 저장 시 동일 함수로 재계산)
  const preview = distNum > 0 && priceNum > 0
    ? calcCommute({ mode: 'lodging_return', distanceOnewayKm: distNum, fuelEfficiency: efficiency, fuelPrice: priceNum, tollRoundtrip: tollNum, multiplier: 1 })
    : null

  // 카카오 길찾기 경로 자동조회 (KAKAO_REST_API_KEY 설정 시 동작 — 실패 시 수동입력 안내)
  function handleAutoRoute() {
    setError('')
    if (!siteAddress) { setError('현장 주소가 등록되어 있지 않습니다. 거리를 직접 입력하세요.'); return }
    if (!homeAddress) { setError('자택주소를 입력하세요.'); return }
    const formData = new FormData()
    formData.set('home_address', homeAddress)
    formData.set('site_address', siteAddress)
    formData.set('fuel_type', fuelType)
    formData.set('fuel_price', fuelPrice.replace(/,/g, '') || '1')
    startTransition(async () => {
      const res = await calcCommuteCost(formData)
      if ('error' in res) {
        setError(res.error + ' — 지도에서 확인한 편도거리를 직접 입력해도 됩니다.')
      } else {
        setDistanceOneway(String(res.data.distanceOneWayKm))
        setToll(res.data.tollRoundTrip > 0 ? res.data.tollRoundTrip.toLocaleString('ko-KR') : '')
      }
    })
  }

  // 오피넷 전국 일별 평균 유가 자동조회 — 기준일 미선택 시 오늘 유가
  function handleAutoFuelPrice() {
    setError('')
    const targetDate = fuelPriceDate || new Date().toISOString().slice(0, 10)
    startTransition(async () => {
      const res = await getFuelPriceForDate(targetDate, fuelType)
      if ('error' in res) {
        setError(res.error)
      } else {
        setFuelPrice(res.data.price.toLocaleString('ko-KR'))
        setFuelPriceDate(res.data.date)
      }
    })
  }

  function handleApply() {
    if (!preview) return
    onApply({
      homeAddress,
      distanceOnewayKm: distNum,
      fuelType,
      fuelEfficiency: efficiency,
      fuelPrice: priceNum,
      fuelPriceDate: fuelPriceDate || null,
      fuelCostRoundtrip: preview.fuelCostRoundtrip,
      tollRoundtrip: tollNum,
      costPerTrip: preview.costPerTrip,
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
      <p className="text-xs font-semibold text-gray-600">
        🚗 자차 교통비 산출 — 왕복거리 × 유가 ÷ 연비 + 통행료 (공무원보수 등의 업무지침 기준)
      </p>

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        <div>
          <label className="mb-0.5 block text-xs text-gray-500">자택주소</label>
          <input
            type="text" value={homeAddress} onChange={(e) => setHomeAddress(e.target.value)}
            placeholder="예: 충북 단양군 단양읍 수변로 27"
            className="w-full rounded border border-gray-300 px-2 py-1.5 text-sm focus:border-blue-500 focus:outline-none"
          />
        </div>
        <div>
          <label className="mb-0.5 block text-xs text-gray-500">현장주소</label>
          <input type="text" value={siteAddress} readOnly
            className="w-full rounded border border-gray-200 bg-gray-100 px-2 py-1.5 text-sm text-gray-500" />
        </div>
        <div>
          <label className="mb-0.5 block text-xs text-gray-500">편도거리 (km)</label>
          <div className="flex gap-1">
            <input
              type="text" inputMode="decimal" value={distanceOneway}
              onChange={(e) => setDistanceOneway(e.target.value.replace(/[^0-9.]/g, ''))}
              placeholder="예: 123.4"
              className="w-full rounded border border-gray-300 px-2 py-1.5 text-sm focus:border-blue-500 focus:outline-none"
            />
            <button type="button" onClick={handleAutoRoute} disabled={isPending}
              title="카카오 길찾기 경로 자동조회 (거리·통행료 자동 입력)"
              className="whitespace-nowrap rounded border border-green-300 bg-white px-2 py-1.5 text-xs text-green-700 hover:bg-green-50 disabled:opacity-50">
              {isPending ? '…' : '자동'}
            </button>
          </div>
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
          <label className="mb-0.5 block text-xs text-gray-500">유가 ({FUEL_EFFICIENCY[fuelType].priceUnit})</label>
          <div className="flex gap-1">
            <input
              type="text" inputMode="numeric" value={fuelPrice}
              onChange={(e) => { const r = e.target.value.replace(/[^0-9]/g, ''); setFuelPrice(r ? parseInt(r).toLocaleString('ko-KR') : '') }}
              placeholder="예: 1,650"
              className="w-full rounded border border-gray-300 px-2 py-1.5 text-sm focus:border-blue-500 focus:outline-none"
            />
            <button type="button" onClick={handleAutoFuelPrice} disabled={isPending}
              title="오피넷 전국 일별 평균 유가 자동조회 (기준일 미선택 시 오늘)"
              className="whitespace-nowrap rounded border border-green-300 bg-white px-2 py-1.5 text-xs text-green-700 hover:bg-green-50 disabled:opacity-50">
              {isPending ? '…' : '자동'}
            </button>
          </div>
        </div>
        <div>
          <label className="mb-0.5 block text-xs text-gray-500">유가 기준일 (opinet.co.kr 고시)</label>
          <input type="date" value={fuelPriceDate} onChange={(e) => setFuelPriceDate(e.target.value)}
            className="w-full rounded border border-gray-300 px-2 py-1.5 text-sm focus:border-blue-500 focus:outline-none" />
        </div>
        <div>
          <label className="mb-0.5 block text-xs text-gray-500">통행료 (왕복)</label>
          <input
            type="text" inputMode="numeric" value={toll}
            onChange={(e) => { const r = e.target.value.replace(/[^0-9]/g, ''); setToll(r ? parseInt(r).toLocaleString('ko-KR') : '') }}
            placeholder="예: 5,000"
            className="w-full rounded border border-gray-300 px-2 py-1.5 text-sm focus:border-blue-500 focus:outline-none"
          />
        </div>
      </div>

      {isOwnRow && (
        <button type="button" onClick={handleSaveMyInfo}
          className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-xs text-gray-600 hover:bg-gray-50">
          {saved ? '저장됨 ✓' : '자택주소·차종을 내 정보로 저장'}
        </button>
      )}

      {error && <p className="text-xs text-red-600">{error}</p>}

      {preview && (
        <div className="rounded-lg border border-green-200 bg-white p-3 space-y-1">
          <div className="flex justify-between text-xs text-gray-600">
            <span>왕복거리 (편도 {distNum}km × 2)</span>
            <span>{preview.distanceRoundtripKm}km</span>
          </div>
          <div className="flex justify-between text-xs text-gray-600">
            <span>왕복 유류비 ({preview.distanceRoundtripKm}km × {priceNum.toLocaleString()} ÷ {efficiency})</span>
            <span>{formatKRW(preview.fuelCostRoundtrip)}</span>
          </div>
          <div className="flex justify-between text-xs text-gray-600">
            <span>통행료 (왕복)</span>
            <span>{formatKRW(tollNum)}</span>
          </div>
          <div className="flex justify-between border-t pt-1 text-sm font-semibold text-green-700">
            <span>1회 왕복 교통비</span>
            <span>{formatKRW(preview.costPerTrip)}</span>
          </div>
          <button
            type="button"
            onClick={handleApply}
            className="mt-1 w-full rounded-md bg-blue-600 py-1.5 text-xs font-medium text-white hover:bg-blue-700"
          >
            이 금액을 1회 왕복비로 적용
          </button>
        </div>
      )}
    </div>
  )
}
