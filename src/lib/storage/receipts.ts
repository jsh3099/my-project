// 증빙 파일 주소 규약 — 한 곳에서만 관리한다.
//
// `receipts` 버킷은 비공개다(public=false). 계약서·이체확인증·재직증명서가 들어 있어
// 링크만 알면 누구나 보는 상태가 되면 안 된다(PRD 5.3 — 서버 서명 URL 방식).
// 그래서 DB에는 "열람 주소"가 아니라 **스토리지 경로**를 저장하고, 화면은
// `/api/receipts`를 거쳐 **열람 시점에** 단기 서명 URL을 발급받는다.
// 서명 URL은 만료되므로 DB에 저장하면 얼마 뒤 다시 죽은 링크가 된다 — 저장하면 안 된다.
//
// 저장 형식(`stored`) 두 가지를 모두 읽는다:
//   신규   `receipts/<uid>/<ts>_<rand>.pdf#<원본파일명>`         (경로)
//   레거시 `https://…/object/public/receipts/receipts/<uid>/….pdf#<원본파일명>`
// 레거시는 비공개 버킷에 `getPublicUrl()`을 쓰던 시절의 값이다. 링크 자체는 죽어 있지만
// 경로가 그 안에 들어 있어, 아래 파서가 되돌려 읽으면 **기존 첨부도 그대로 열린다**.
// (DB에 쌓인 값을 마이그레이션으로 손대지 않는 이유 — 이 값은 `kept::`·첨부 삭제에서
//  동일성 비교 키로도 쓰이므로 형식을 바꾸면 화면·서버의 짝이 어긋난다)
//
// `#원본파일명` 프래그먼트: 스토리지 키에는 한글·`~`를 넣을 수 없어(Invalid key)
// 원본 파일명을 프래그먼트에 보관한다. 프래그먼트는 서버로 전송되지 않으므로
// 업로드 경로나 서명에는 영향이 없다.

export const RECEIPTS_BUCKET = 'receipts'

// 서명 URL 유효시간(초). 리다이렉트 직후 열람하는 용도이므로 짧게 두되,
// PDF 뷰어가 이어서 보내는 범위 요청(range request)까지는 살아 있어야 한다.
export const RECEIPT_SIGN_TTL_SEC = 300

const PUBLIC_MARKER = `/object/public/${RECEIPTS_BUCKET}/`
const SIGN_MARKER = `/object/sign/${RECEIPTS_BUCKET}/`

// 업로드 직후 DB에 넣을 값을 만든다 — 경로 + 원본 파일명 프래그먼트
export function receiptStoredValue(path: string, fileName?: string | null): string {
  return fileName ? `${path}#${encodeURIComponent(fileName)}` : path
}

// 저장된 값에서 스토리지 경로를 되돌린다. 읽을 수 없으면 null.
export function receiptStoragePath(stored: string): string | null {
  if (!stored) return null
  const bare = stored.split('#')[0].trim()
  if (!bare) return null

  let path: string
  const pub = bare.indexOf(PUBLIC_MARKER)
  const sign = bare.indexOf(SIGN_MARKER)
  if (pub >= 0) {
    path = decodeURIComponent(bare.slice(pub + PUBLIC_MARKER.length))
  } else if (sign >= 0) {
    // 서명 URL은 ?token=… 이 붙는다 — DB에 있을 값은 아니지만 들어와도 읽어준다
    path = decodeURIComponent(bare.slice(sign + SIGN_MARKER.length).split('?')[0])
  } else if (/^https?:\/\//i.test(bare)) {
    // 우리 버킷 주소가 아닌 외부 URL — 서명 대상이 아니다
    return null
  } else {
    path = bare.replace(/^\/+/, '')
  }

  // 경로 탈출 차단 — 저장값은 사용자가 되돌려 보낼 수 있는 값이므로 신뢰하지 않는다
  if (!path || path.split('/').some((seg) => seg === '..')) return null
  return path
}

// 화면 칩에 보여줄 이름 — 프래그먼트의 원본 파일명, 없으면 경로 마지막 조각
export function receiptFileName(stored: string): string {
  const hash = stored.split('#')[1]
  if (hash) {
    try {
      return decodeURIComponent(hash)
    } catch {
      return hash
    }
  }
  const last = stored.split('#')[0].split('?')[0].split('/').pop() ?? ''
  try {
    return decodeURIComponent(last) || '첨부파일'
  } catch {
    return last || '첨부파일'
  }
}

// `<a href>`에 넣을 열람 주소. 실제 서명은 이 라우트가 클릭 시점에 발급한다.
export function receiptHref(stored: string): string {
  return `/api/receipts?p=${encodeURIComponent(stored)}`
}

// 이미지 첨부인지 (정산서 산출서에 임베드할 지도 캡처 판별)
export function isImageReceipt(stored: string): boolean {
  return /\.(png|jpe?g)(#|\?|$)/i.test(stored.split('?')[0])
}
