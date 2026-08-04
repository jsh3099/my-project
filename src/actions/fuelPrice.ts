'use server'

// 운행일자 기준 유가 자동조회 — 오피넷 전국 일별 평균가 (캐시 우선)
//
// 캐시(fuel_prices)에 있으면 그대로, 없으면 오피넷 최근 7일 + 당일 평균을
// 조회해 적재한 뒤 반환한다. 7일보다 오래된 운행일은 무료 API로 조회할 수
// 없으므로 수기 입력을 안내한다 (한 번 캐시된 날짜는 계속 사용 가능).

import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { opinetProductCode, fetchRecentDailyPrices, fetchTodayPrice } from '@/lib/opinet'
import type { VehicleFuelType } from '@/lib/constants'

export interface FuelPriceResult {
  date: string   // 적용된 유가 기준일 (YYYY-MM-DD)
  price: number  // 전국 일별 평균가 (원, 반올림)
}

export async function getFuelPriceForDate(
  date: string,
  fuelType: VehicleFuelType,
): Promise<{ error: string } | { success: true; data: FuelPriceResult }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: '로그인이 필요합니다.' }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { error: '유가 기준일이 올바르지 않습니다.' }
  const productCode = opinetProductCode(fuelType)
  if (!productCode) return { error: '전기·수소 차량은 유가 자동조회를 지원하지 않습니다. 단가를 직접 입력하세요.' }

  const admin = createAdminClient()

  // 1) 캐시 조회
  const { data: cached } = await admin
    .from('fuel_prices')
    .select('price_date, price')
    .eq('price_date', date)
    .eq('product_code', productCode)
    .maybeSingle()
  if (cached) {
    return { success: true, data: { date: cached.price_date, price: Math.round(Number(cached.price)) } }
  }

  // 2) 오피넷 조회 (최근 7일 + 당일) 후 캐시 적재
  try {
    const [recent, today] = await Promise.all([
      fetchRecentDailyPrices(productCode),
      fetchTodayPrice(productCode),
    ])
    const rows = [...recent, ...(today ? [today] : [])]
    if (rows.length > 0) {
      await admin.from('fuel_prices').upsert(
        rows.map((r) => ({ price_date: r.date, product_code: productCode, price: r.price })),
        { onConflict: 'price_date,product_code' },
      )
    }
    const hit = rows.find((r) => r.date === date)
    if (hit) return { success: true, data: { date: hit.date, price: hit.price } }

    return {
      error: `${date} 유가는 오피넷 무료 API 조회 범위(최근 7일)를 벗어났습니다. opinet.co.kr에서 해당일 유가를 확인해 직접 입력하세요.`,
    }
  } catch (e) {
    return { error: e instanceof Error ? e.message : '유가 조회 중 오류가 발생했습니다.' }
  }
}
