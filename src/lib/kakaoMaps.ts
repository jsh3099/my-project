// 카카오 API 연동 — 주소 지오코딩(카카오 로컬) + 자동차 길찾기(카카오모빌리티)
//
// developers.kakao.com 앱의 REST API 키를 .env.local에 KAKAO_REST_API_KEY로 설정.
// 지오코딩은 앱의 [제품 설정 > 카카오맵] 사용 설정 ON 필요.
// 무료 쿼터: 카카오맵(로컬) 일 무료 제공, 자동차 길찾기 일 10,000건 무료.

const GEOCODE_URL = 'https://dapi.kakao.com/v2/local/search/address.json'
const DIRECTIONS_URL = 'https://apis-navi.kakaomobility.com/v1/directions'

function authHeaders() {
  const key = process.env.KAKAO_REST_API_KEY
  if (!key) {
    throw new Error('KAKAO_REST_API_KEY 환경변수가 설정되지 않았습니다.')
  }
  return { Authorization: `KakaoAK ${key}` }
}

export type GeoPoint = { lat: number; lng: number }

export async function geocodeAddress(address: string): Promise<GeoPoint> {
  const url = `${GEOCODE_URL}?query=${encodeURIComponent(address)}`
  const res = await fetch(url, { headers: authHeaders() })
  if (!res.ok) throw new Error(`지오코딩 요청 실패 (${res.status})`)
  const data = await res.json()
  const first = data.documents?.[0]
  if (!first) throw new Error(`주소를 찾을 수 없습니다: ${address}`)
  return { lat: parseFloat(first.y), lng: parseFloat(first.x) }
}

export type DrivingRoute = {
  distanceKm: number
  durationMin: number
  tollFare: number
}

export async function getDrivingRoute(from: GeoPoint, to: GeoPoint): Promise<DrivingRoute> {
  const url = `${DIRECTIONS_URL}?origin=${from.lng},${from.lat}&destination=${to.lng},${to.lat}`
  const res = await fetch(url, { headers: authHeaders() })
  if (!res.ok) throw new Error(`경로 조회 실패 (${res.status})`)
  const data = await res.json()
  const route = data.routes?.[0]
  if (!route || route.result_code !== 0) {
    throw new Error(`경로를 찾을 수 없습니다.${route?.result_msg ? ` (${route.result_msg})` : ''}`)
  }
  return {
    distanceKm: route.summary.distance / 1000, // m → km
    durationMin: Math.round(route.summary.duration / 60), // s → 분
    tollFare: route.summary.fare?.toll ?? 0,
  }
}
