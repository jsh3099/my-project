import { describe, it, expect, beforeAll } from 'vitest'
import fs from 'fs'
import path from 'path'
import { extractPdfLines } from '@/lib/attendance/parseSheet'
import { parseRentTotal, parseMaintItems, parseResidenceAddress } from '../parseReceipt'

const FIXTURES = path.join(__dirname, 'fixtures')
const readFixture = (name: string) => new Uint8Array(fs.readFileSync(path.join(FIXTURES, name)))

// ── 거주지 증빙(재직증명서) 주소 인식 ──────────────────────────
// 교통비·출장비 산출의 출발지가 되는 값이라, 주소를 잘못 잡으면 거리·금액이 통째로 어긋난다.
//
// 종전에는 증빙에 실제 거주지가 들어가 공개 저장소에 커밋할 수 없었고, 그래서
// 바탕화면 절대경로를 가리키며 기대값도 코드에 적지 못했다(정규식 검증만, 사실상 영구 skip).
// 이제 `scripts/gen-test-evidence.ts`가 **가상 주소**로 증빙을 만들므로 픽스처를 커밋해
// 어느 PC에서든 돌리고, 기대 주소를 정확히 대조한다.
//
// 픽스처를 다시 만들 때: `node --experimental-strip-types scripts/gen-test-evidence.ts --with-fixtures`
// (주소 문자열은 생성기의 HOME_ADDRESSES와 한 쌍이다 — 한쪽만 바꾸면 이 테스트가 잡아낸다)
// 주소 형태를 흩어 `ADDR_REGION`의 분기(도 단위 / 시·구 / 특별시)와
// 표기 형태(도로명 + 동·호 / 층 / **지번**)를 함께 덮는다
const CERTS: [string, string][] = [
  ['cert_chungbuk_apt.pdf', '충청북도 청주시 서원구 테스트로 100, 가상아파트 101동 1001호'],
  ['cert_chungbuk_villa.pdf', '충북 청주시 흥덕구 시험대로 22, 샘플빌라 3층'],
  ['cert_seoul.pdf', '서울특별시 용산구 예시로 45, 테스트타워 12층 1203호'],
  ['cert_seoul_jibun.pdf', '서울시 마포구 도화동 100-1번지'],
]

describe('거주지 증빙 주소 인식', () => {
  it.each(CERTS)('%s — 자택주소를 그대로 읽는다', async (file, expected) => {
    const addr = parseResidenceAddress(await extractPdfLines(readFixture(file)))
    expect(addr).toBe(expected)
  })

  // 소속란의 회사·현장명을 자택주소로 잡으면 산출 출발지가 어긋난다.
  // 증명서에는 주소 줄 아래에 소속·용도 줄이 함께 있으므로 실제로 헷갈릴 수 있는 배치다.
  it.each(CERTS)('%s — 소속·용도 줄을 주소로 잡지 않는다', async (file) => {
    const addr = parseResidenceAddress(await extractPdfLines(readFixture(file)))
    expect(addr).not.toContain('테스트씨엠')
    expect(addr).not.toContain('건설사업관리단')
    expect(addr).not.toContain('직접경비')
  })

  // 라벨만 있고 값이 다른 칸에 있는 경우를 걸러내는지 (PDF가 필요 없는 검증)
  it('소속·용도 줄 단독으로는 주소를 만들지 않는다', () => {
    expect(parseResidenceAddress(['소속 테스트씨엠 (가상) 도매시장 5회차 건설사업관리단'])).toBe('')
    expect(parseResidenceAddress(['용도 직접경비 정산 — 교통비 산출 거주지 확인용'])).toBe('')
  })
})

// ── 배포용 증빙 묶음 회귀 확인 ─────────────────────────────────
// 위 픽스처는 파서를 지키고, 이 블록은 **테스터에게 배포하는 실제 묶음**이 파서와 계속 맞는지 지킨다.
// 목적이 다르므로 둘을 함께 둔다. 생성기를 돌린 PC에서만 실행된다(없으면 skip).
// 경로는 생성기 기본 출력 위치 — 다른 곳에 만들었으면 TEST_EVIDENCE_DIR로 알려준다.
const EVIDENCE_DIR =
  process.env.TEST_EVIDENCE_DIR ??
  path.join(process.env.USERPROFILE ?? '', 'Desktop', '테스트증빙_5회차')
const RENT = path.join(EVIDENCE_DIR, '2.주재비_숙소', '테스트_숙소임대비_이체확인증_성혁기_2026-04~08.pdf')

describe.skipIf(!fs.existsSync(RENT))('배포용 증빙 — 숙소임대비 이체확인증 (2026-04~08)', () => {
  let lines: string[]

  beforeAll(async () => {
    lines = await extractPdfLines(new Uint8Array(fs.readFileSync(RENT)))
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
