// 네이버 클라우드 플랫폼(NCP) Maps API 연동
//
// NCP 콘솔(console.ncloud.com) > AI·NAVER API > Maps 애플리케이션 등록 후
// 발급받은 Client ID/Secret을 .env.local에 NCP_MAPS_CLIENT_ID / NCP_MAPS_CLIENT_SECRET로 설정해야 동작한다.
// ⚠ 엔드포인트·헤더명은 NCP가 주기적으로 개편하므로, 실제 연동 전 콘솔의 최신 API 참조서로 한 번 대조 확인할 것.

const GEOCODE_URL = 'https://maps.apigw.ntruss.com/map-geocode/v2/geocode'
const DIRECTIONS_URL = 'https://maps.apigw.ntruss.com/map-direction/v1/driving'

function authHeaders() {
  const clientId = process.env.NCP_MAPS_CLIENT_ID
  const clientSecret = process.env.NCP_MAPS_CLIENT_SECRET
  if (!clientId || !clientSecret) {
    throw new Error('NCP_MAPS_CLIENT_ID / NCP_MAPS_CLIENT_SECRET 환경변수가 설정되지 않았습니다.')
  }
  return {
    'x-ncp-apigw-api-key-id': clientId,
    'x-ncp-apigw-api-key': clientSecret,
  }
}

export type GeoPoint = { lat: number; lng: number }

export async function geocodeAddress(address: string): Promise<GeoPoint> {
  const url = `${GEOCODE_URL}?query=${encodeURIComponent(address)}`
  const res = await fetch(url, { headers: authHeaders() })
  if (!res.ok) throw new Error(`지오코딩 요청 실패 (${res.status})`)
  const data = await res.json()
  const first = data.addresses?.[0]
  if (!first) throw new Error(`주소를 찾을 수 없습니다: ${address}`)
  return { lat: parseFloat(first.y), lng: parseFloat(first.x) }
}

export type DrivingRoute = {
  distanceKm: number
  durationMin: number
  tollFare: number
}

export async function getDrivingRoute(from: GeoPoint, to: GeoPoint): Promise<DrivingRoute> {
  const url = `${DIRECTIONS_URL}?start=${from.lng},${from.lat}&goal=${to.lng},${to.lat}&option=trafast`
  const res = await fetch(url, { headers: authHeaders() })
  if (!res.ok) throw new Error(`경로 조회 실패 (${res.status})`)
  const data = await res.json()
  const summary = data.route?.trafast?.[0]?.summary
  if (!summary) throw new Error('경로를 찾을 수 없습니다.')
  return {
    distanceKm: summary.distance / 1000,
    durationMin: Math.round(summary.duration / 60000),
    tollFare: summary.tollFare ?? 0,
  }
}
