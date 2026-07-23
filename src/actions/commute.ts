'use server'

import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { geocodeAddress, getDrivingRoute } from '@/lib/naverMaps'
import { FUEL_EFFICIENCY, type VehicleFuelType } from '@/lib/constants'

export async function saveMyTransportInfo(formData: FormData) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: '로그인이 필요합니다.' }

  const homeAddress = formData.get('home_address') as string
  const vehicleFuelType = formData.get('vehicle_fuel_type') as string
  if (!homeAddress) return { error: '자택주소를 입력하세요.' }
  if (!(vehicleFuelType in FUEL_EFFICIENCY)) return { error: '차종을 선택하세요.' }

  const admin = createAdminClient()
  const { error } = await admin
    .from('profiles')
    .update({ home_address: homeAddress, vehicle_fuel_type: vehicleFuelType })
    .eq('id', user.id)

  if (error) return { error: '저장 실패: ' + error.message }
  return { success: true }
}

export interface CommuteCalcResult {
  distanceOneWayKm: number
  distanceRoundTripKm: number
  tollRoundTrip: number
  fuelCost: number
  total: number
}

export async function calcCommuteCost(formData: FormData): Promise<{ error: string } | { success: true; data: CommuteCalcResult }> {
  const homeAddress = formData.get('home_address') as string
  const siteAddress = formData.get('site_address') as string
  const fuelType = formData.get('fuel_type') as VehicleFuelType
  const fuelPrice = Number(formData.get('fuel_price'))

  if (!homeAddress || !siteAddress) return { error: '자택주소와 현장주소가 모두 필요합니다.' }
  if (!FUEL_EFFICIENCY[fuelType]) return { error: '차종을 선택하세요.' }
  if (!fuelPrice || fuelPrice <= 0) return { error: '유가를 입력하세요.' }

  try {
    const [home, site] = await Promise.all([geocodeAddress(homeAddress), geocodeAddress(siteAddress)])
    const route = await getDrivingRoute(home, site)

    const distanceRoundTripKm = route.distanceKm * 2
    const tollRoundTrip = route.tollFare * 2
    const fuelCost = Math.round((distanceRoundTripKm * fuelPrice) / FUEL_EFFICIENCY[fuelType].value)

    return {
      success: true,
      data: {
        distanceOneWayKm: route.distanceKm,
        distanceRoundTripKm,
        tollRoundTrip,
        fuelCost,
        total: fuelCost + tollRoundTrip,
      },
    }
  } catch (e) {
    return { error: e instanceof Error ? e.message : '경로 계산 중 오류가 발생했습니다.' }
  }
}
