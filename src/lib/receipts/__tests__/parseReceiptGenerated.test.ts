import { describe, it, expect, beforeAll } from 'vitest'
import fs from 'fs'
import path from 'path'
import { extractPdfLines } from '@/lib/attendance/parseSheet'
import { parseRentTotal, parseMaintItems, parseResidenceAddress } from '../parseReceipt'

// 사용자 배포용 테스트 증빙(바탕화면 테스트증빙_5회차 폴더)이 파서와 계속 맞는지 확인한다.
// 금액·개월 수를 바꾸면 이 파일도 함께 다시 만들어야 한다. (파일 없으면 skip)
const RENT = 'C:/Users/user/Desktop/테스트증빙_5회차/2.테스트_숙소임대비_이체확인증_2026-04~08.pdf'

describe.skipIf(!fs.existsSync(RENT))('배포용 테스트 숙소임대비 이체확인증 (2026-04~08)', () => {
  let lines: string[]

  beforeAll(async () => {
    lines = await extractPdfLines(new Uint8Array(fs.readFileSync(path.normalize(RENT))))
  })

  it('이체금액을 합산해 기성기간 임대비 총액을 인식한다 (월 50만 × 5개월)', () => {
    expect(parseRentTotal(lines)).toBe(2_500_000)
  })

  // 표지 요약표는 "이체금액" 문구를 쓰지 않아야 한다 — 쓰면 월별 이체금액과 이중 합산된다
  it('표지 요약표가 이체금액 합산에 중복 계상되지 않는다', () => {
    expect(lines.filter((l) => /이체금액\s*[\d,]+\s*원/.test(l))).toHaveLength(5)
  })

  // 임대비 문서에서 관리비(전기·가스) 항목이 잘못 잡히면 관리비 칸이 오염된다
  it('관리비 항목은 인식되지 않는다', () => {
    expect(parseMaintItems(lines)).toEqual([])
  })
})

// 거주지 증빙(재직증명서) 주소 인식 — 교통비 산출 자택주소로 자동 매핑되는 값.
// 증빙에 실제 거주지가 들어가므로 기대값을 코드에 적지 않는다 (공개 저장소).
// 대신 "행정구역이 있는 주소를 뽑아냈는지 / 회사 주소를 잡지 않았는지"를 검증한다.
const CERT_DIR = 'C:/Users/user/Desktop/테스트증빙_5회차/테스트 재직증명서(4명분)'
const CERTS = [
  '테스트_재직증명서_강희철(상주).pdf',
  '테스트_재직증명서_성혁기(상주).pdf',
  '테스트_재직증명서_류익선(기술지원).pdf',
  '테스트_재직증명서_김태식(기술지원).pdf',
]

describe.skipIf(!fs.existsSync(CERT_DIR))('배포용 테스트 재직증명서 주소 인식', () => {
  it.each(CERTS)('%s 에서 자택주소를 읽는다', async (file) => {
    const lines = await extractPdfLines(new Uint8Array(fs.readFileSync(path.join(CERT_DIR, file))))
    const addr = parseResidenceAddress(lines)
    expect(addr).toMatch(/(특별시|광역시|[가-힣]{2,}도|[가-힣]{2,}시|[가-힣]{2,}군|[가-힣]{2,}구)/)
    expect(addr.length).toBeGreaterThanOrEqual(8)
    // 소속란의 회사·현장명을 자택주소로 잡으면 산출 출발지가 어긋난다
    expect(addr).not.toContain('선엔지니어링')
    expect(addr).not.toContain('건설사업관리단')
  })
})

// 이 검증은 PDF가 필요 없다(문자열 입력) — 위 skipIf 블록 안에 있어 픽스처 없는 기기에서
// 함께 건너뛰어지던 것을 밖으로 꺼냈다. 어디서든 돌아야 하는 검증이다.
describe('거주지 증빙 주소 인식 — 오인 방지', () => {
  // 소속(회사 주소)·용도 줄이 자택주소로 잘못 잡히면 산출 출발지가 오염된다
  it('소속·용도 줄을 주소로 오인하지 않는다', () => {
    expect(parseResidenceAddress(['소속 선엔지니어링 (테스트) 도매시장 5회차 건설사업관리단'])).toBe('')
    expect(parseResidenceAddress(['용도 직접경비 정산 — 교통비 산출 거주지 확인용'])).toBe('')
  })
})
