'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { calcCommuteCost, saveMyTransportInfo } from '@/actions/commute'
import { updateSiteAddress } from '@/actions/sites'
import { getFuelPriceForDate, getFuelPriceAverageForPeriod } from '@/actions/fuelPrice'
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
  siteId: string
  siteAddress: string
  isOwnRow: boolean
  defaultHomeAddress?: string | null
  defaultFuelType?: string | null
  /** 근무기간 — 유가 기준일을 비워두면 이 기간의 오피넷 평균가를 적용한다 (A안) */
  periodStart?: string | null
  periodEnd?: string | null
  /** 이미 산출·저장된 값 — 없으면 빈칸으로 시작한다.
   *  이게 없으면 패널을 열 때마다 거리·유가·통행료가 공란이라 매번 재조회하게 된다. */
  initial?: {
    distanceOnewayKm?: number
    fuelType?: string | null
    fuelPrice?: number
    fuelPriceDate?: string | null
    tollRoundtrip?: number
  } | null
  onApply: (params: CommuteApplyParams) => void
}

function formatKRW(n: number) {
  return n.toLocaleString('ko-KR') + '원'
}

export function CommuteCalcPanel({ siteId, siteAddress, isOwnRow, defaultHomeAddress, defaultFuelType, periodStart, periodEnd, initial, onApply }: Props) {
  const router = useRouter()
  const [homeAddress, setHomeAddress] = useState(defaultHomeAddress ?? '')
  // 현장주소 — 현장 등록 정보(sites.address)가 기본값이고, 여기서 고쳐 저장하면 다음부터 자동 입력
  const [siteAddr, setSiteAddr] = useState(siteAddress)
  const [siteAddrSaved, setSiteAddrSaved] = useState(false)
  // 고속도로 우선(시간 우선 경로) — 추천 경로가 무료도로면 통행료가 0으로 나오므로,
  // 실제로 고속도로로 다니는 인원은 이 옵션으로 거리·통행료를 산출한다
  const [highwayFirst, setHighwayFirst] = useState(true)
  // 이미 산출·저장된 값이 있으면 그대로 이어서 본다 — 수정할 것만 고치고 다시 적용하면 된다
  const [fuelType, setFuelType] = useState<VehicleFuelType>(
    (initial?.fuelType as VehicleFuelType) ?? (defaultFuelType as VehicleFuelType) ?? 'gasoline',
  )
  const [fuelPrice, setFuelPrice] = useState(
    initial?.fuelPrice && initial.fuelPrice > 0 ? initial.fuelPrice.toLocaleString('ko-KR') : '',
  )
  const [fuelPriceDate, setFuelPriceDate] = useState(initial?.fuelPriceDate ?? '')
  // 유가 산정 근거 안내 — 기간 평균으로 채웠을 때 표본을 보여준다
  const [fuelBasis, setFuelBasis] = useState('')
  const [distanceOneway, setDistanceOneway] = useState(
    initial?.distanceOnewayKm && initial.distanceOnewayKm > 0 ? String(initial.distanceOnewayKm) : '',
  ) // 편도 km — 수동입력 or 경로조회로 채움
  const [toll, setToll] = useState(
    initial?.tollRoundtrip && initial.tollRoundtrip > 0 ? initial.tollRoundtrip.toLocaleString('ko-KR') : '',
  ) // 왕복 통행료
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
    if (!siteAddr) { setError('현장주소를 입력하세요.'); return }
    if (!homeAddress) { setError('자택주소를 입력하세요.'); return }
    const formData = new FormData()
    formData.set('home_address', homeAddress)
    formData.set('site_address', siteAddr)
    formData.set('fuel_type', fuelType)
    formData.set('fuel_price', fuelPrice.replace(/,/g, '') || '1')
    formData.set('route_priority', highwayFirst ? 'TIME' : 'RECOMMEND')
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

  // 오피넷 유가 자동조회 — 기준일을 고르면 해당일, 비워두면 근무기간 평균가(A안).
  // 기간 평균은 특정일 유가의 치우침(유리/불리)을 없애 발주청 시비를 줄인다.
  function handleAutoFuelPrice() {
    setError('')
    setFuelBasis('')
    startTransition(async () => {
      if (!fuelPriceDate && periodStart && periodEnd) {
        const res = await getFuelPriceAverageForPeriod(periodStart, periodEnd, fuelType)
        if ('error' in res) {
          setError(res.error)
          return
        }
        setFuelPrice(res.data.price.toLocaleString('ko-KR'))
        setFuelPriceDate('') // 기준일 없음 = 기간 평균 적용 (정산서에도 '기간 평균'으로 표기)
        setFuelBasis(`근무기간(${periodStart}~${periodEnd}) 오피넷 전국 평균 — 고시일 ${res.data.sampleDays}일 표본 (${res.data.from}~${res.data.to})`)
        return
      }
      const targetDate = fuelPriceDate || new Date().toISOString().slice(0, 10)
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

  // 현장주소 저장 — sites.address로 남아 모든 인원·다음 방문에서 자동 입력된다
  function handleSaveSiteAddress() {
    setError('')
    const fd = new FormData()
    fd.set('address', siteAddr)
    startTransition(async () => {
      const res = await updateSiteAddress(siteId, fd)
      if ('error' in res) {
        setError(res.error)
      } else {
        setSiteAddrSaved(true)
        setTimeout(() => setSiteAddrSaved(false), 2000)
        router.refresh()
      }
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
          <label className="mb-0.5 block text-xs text-gray-500">
            현장주소
            {siteAddress && <span className="ml-1 font-semibold text-green-600">✓ 자동 매핑</span>}
          </label>
          {siteAddress ? (
            // 현장 정보(대시보드)에 저장된 주소를 그대로 쓴다 — 단일 입력 지점, 여기서는 수정하지 않는다
            <p className="truncate rounded border border-gray-200 bg-gray-50 px-2 py-1.5 text-sm text-gray-600" title={siteAddress}>
              {siteAddress}
            </p>
          ) : (
            // 아직 미등록이면 이 자리에서 첫 입력을 받는다 (저장 시 대시보드 현장 정보와 동일한 곳에 기록)
            <div className="flex gap-1">
              <input
                type="text" value={siteAddr} onChange={(e) => setSiteAddr(e.target.value)}
                placeholder="예: 충북 청주시 상당구 ○○로 123"
                className="w-full rounded border border-gray-300 px-2 py-1.5 text-sm focus:border-blue-500 focus:outline-none"
              />
              {siteAddr.trim() && (
                <button type="button" onClick={handleSaveSiteAddress} disabled={isPending}
                  title="현장주소로 저장 — 다음부터 모든 인원·모든 산출에 자동 입력됩니다"
                  className="whitespace-nowrap rounded bg-green-600 px-2.5 py-1.5 text-xs font-semibold text-white hover:bg-green-700 disabled:opacity-50">
                  {isPending ? '…' : '저장'}
                </button>
              )}
              {siteAddrSaved && <span className="self-center whitespace-nowrap text-xs text-green-700">✓</span>}
            </div>
          )}
          <p className="mt-0.5 text-[11px] text-gray-400">
            {siteAddress ? '대시보드 · 현장 정보에서 수정할 수 있습니다.' : '한 번 저장하면 대시보드 · 현장 정보에 남아 모든 산출에 자동 반영됩니다.'}
          </p>
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
              title="오피넷 유가 자동조회 — 기준일을 고르면 해당일 고시가, 비워두면 근무기간 평균가"
              className="whitespace-nowrap rounded border border-green-300 bg-white px-2 py-1.5 text-xs text-green-700 hover:bg-green-50 disabled:opacity-50">
              {isPending ? '…' : '자동'}
            </button>
          </div>
        </div>
        <div>
          <label className="mb-0.5 block text-xs text-gray-500">
            유가 기준일 {periodStart && periodEnd ? '(비워두면 근무기간 평균 적용)' : '(opinet.co.kr 고시)'}
          </label>
          <input type="date" value={fuelPriceDate} onChange={(e) => { setFuelPriceDate(e.target.value); setFuelBasis('') }}
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

      <label className="flex w-fit cursor-pointer items-center gap-1.5 text-xs text-gray-600">
        <input
          type="checkbox"
          checked={highwayFirst}
          onChange={(e) => setHighwayFirst(e.target.checked)}
          className="h-3.5 w-3.5 rounded border-gray-300"
        />
        🛣 고속도로 우선 경로로 조회 (시간 우선 — 통행료 포함 경로 기준, 해제 시 카카오 추천 경로)
      </label>

      {isOwnRow && (
        <button type="button" onClick={handleSaveMyInfo}
          className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-xs text-gray-600 hover:bg-gray-50">
          {saved ? '저장됨 ✓' : '자택주소·차종을 내 정보로 저장'}
        </button>
      )}

      {error && <p className="text-xs text-red-600">{error}</p>}
      {fuelBasis && <p className="text-xs text-green-700">✓ 유가 적용 근거: {fuelBasis}</p>}

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
          {/* 적용 = 이 시트의 마무리 동작 — 누르면 값이 카드에 반영되고 시트가 닫힌다 */}
          <button
            type="button"
            onClick={handleApply}
            className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-lg bg-blue-600 py-2.5 text-sm font-bold text-white shadow-sm hover:bg-blue-700"
          >
            {formatKRW(preview.costPerTrip)}을 1회 왕복비로 적용
            <span aria-hidden="true">→</span>
          </button>
          <p className="text-center text-[11px] text-gray-400">적용하면 이 창이 닫히고 인원 카드에 반영됩니다.</p>
        </div>
      )}
    </div>
  )
}
