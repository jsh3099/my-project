// 오피넷(한국석유공사 유가정보서비스) API 연동
//
// 예본 각주 근거: "유가 등은 운행일자의 한국석유공사 유가정보서비스(www.opinet.co.kr)에서
// 고시된 유가를 적용함" — 전국 일별 평균가격을 운행일 기준으로 적용한다.
// 무료 Key(일 1,500건)를 .env.local에 OPINET_API_KEY로 설정.

import type { VehicleFuelType } from '@/lib/constants'

const BASE = 'https://www.opinet.co.kr/api'

// 오피넷 제품코드: B027 휘발유 / D047 자동차용경유 / K015 자동차용부탄(LPG)
// 하이브리드·PHEV는 휘발유 단가 적용, 전기·수소는 유가 개념이 없어 자동조회 미지원
const PRODUCT_BY_FUEL: Partial<Record<VehicleFuelType, string>> = {
  gasoline: 'B027',
  hybrid: 'B027',
  phev: 'B027',
  diesel: 'D047',
  lpg: 'K015',
}

export function opinetProductCode(fuelType: VehicleFuelType): string | null {
  return PRODUCT_BY_FUEL[fuelType] ?? null
}

function apiKey(): string {
  const key = process.env.OPINET_API_KEY
  if (!key) throw new Error('OPINET_API_KEY 환경변수가 설정되지 않았습니다.')
  return key
}

async function call(name: string, params = ''): Promise<Record<string, unknown>> {
  const res = await fetch(`${BASE}/${name}?out=json&code=${apiKey()}${params}`)
  if (!res.ok) throw new Error(`오피넷 요청 실패 (${res.status})`)
  const text = await res.text()
  try {
    return JSON.parse(text)
  } catch {
    throw new Error('오피넷 응답을 해석할 수 없습니다 (키 승인 상태를 확인하세요).')
  }
}

export type DailyPrice = { date: string; price: number } // date: YYYY-MM-DD

function toIsoDate(yyyymmdd: string): string {
  return `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`
}

/** 최근 7일 전국 일별 평균가 (운행일 유가의 기본 원천) */
export async function fetchRecentDailyPrices(productCode: string): Promise<DailyPrice[]> {
  const data = await call('avgRecentPrice.do', `&prodcd=${productCode}`)
  const rows = (data as { RESULT?: { OIL?: { DATE: string; PRICE: number | string }[] } }).RESULT?.OIL ?? []
  return rows.map((r) => ({ date: toIsoDate(String(r.DATE)), price: Math.round(Number(r.PRICE)) }))
}

/** 오늘 전국 평균가 (최근 7일 응답에 당일이 없을 때 보충) */
export async function fetchTodayPrice(productCode: string): Promise<DailyPrice | null> {
  const data = await call('avgAllPrice.do')
  const rows = (data as { RESULT?: { OIL?: { PRODCD: string; PRICE: number | string; TRADE_DT: string }[] } }).RESULT?.OIL ?? []
  const row = rows.find((r) => r.PRODCD === productCode)
  if (!row) return null
  return { date: toIsoDate(String(row.TRADE_DT)), price: Math.round(Number(row.PRICE)) }
}
