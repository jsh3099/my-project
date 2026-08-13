import { describe, it, expect, beforeAll } from 'vitest'
import fs from 'fs'
import path from 'path'
import { extractPdfLines, parseResidentDays, parseSupportVisits } from '../parseSheet'

// 테스터에게 배포하는 실제 출근부 묶음이 파서와 계속 맞는지 지킨다.
// (파서 자체 검증은 커밋된 픽스처를 쓰는 parseSheet.test.ts가 담당 — 목적이 다르다)
//
// 경로는 `scripts/gen-test-evidence.ts`의 기본 출력 위치다. 다른 곳에 만들었으면
// TEST_EVIDENCE_DIR 로 알려준다. 생성기를 돌리지 않은 PC에서는 skip된다.
// 명부·일수 사양은 생성기와 한 쌍이므로, 한쪽만 바뀌면 여기서 잡힌다.
const EVIDENCE_DIR =
  process.env.TEST_EVIDENCE_DIR ??
  path.join(process.env.USERPROFILE ?? '', 'Desktop', '테스트증빙_5회차')
const SHEET_DIR = path.join(EVIDENCE_DIR, '1.출근부')
const RESIDENT = path.join(SHEET_DIR, '테스트_출근부_상주_2026-04~08.pdf')
const SUPPORT = path.join(SHEET_DIR, '테스트_출근부_기술지원_2026-04~08.pdf')

const RESIDENT_NAMES = ['강희철', '성혁기']
const SUPPORT_NAMES = ['류익선', '김태식']
const EXPECTED_DAYS: Record<number, number> = { 4: 22, 5: 19, 6: 22, 7: 23, 8: 20 }

describe.skipIf(!fs.existsSync(RESIDENT))('배포용 출근부 — 상주 (2026-04~08)', () => {
  let lines: string[]

  beforeAll(async () => {
    lines = await extractPdfLines(new Uint8Array(fs.readFileSync(RESIDENT)))
  })

  it('월별 출근일수를 인원별로 인식한다 (합계 106일)', () => {
    let total = 0
    for (const [month, days] of Object.entries(EXPECTED_DAYS)) {
      const result = parseResidentDays(lines, RESIDENT_NAMES, 2026, Number(month))
      expect(result, `2026-${month}월`).toEqual({ 강희철: days, 성혁기: days })
      total += days
    }
    expect(total).toBe(106)
  })

  // 총괄표 헤더에 두 이름이 모두 있으므로, 명부 순서가 달라도 열 순서를 헤더에서 잡아낸다
  it('명부 순서가 표와 달라도 열을 이름으로 맞춘다', () => {
    expect(parseResidentDays(lines, ['성혁기', '강희철'], 2026, 7)).toEqual({ 강희철: 23, 성혁기: 23 })
  })
})

describe.skipIf(!fs.existsSync(SUPPORT))('배포용 출근부 — 기술지원 (2026-04~08)', () => {
  let lines: string[]

  beforeAll(async () => {
    lines = await extractPdfLines(new Uint8Array(fs.readFileSync(SUPPORT)))
  })

  // 방문일은 월 1회 — 류익선=2번째 화요일 / 김태식=2번째 목요일 (전 회차 인당 5일)
  it('방문일자를 인원별·월별로 인식한다', () => {
    expect(parseSupportVisits(lines, SUPPORT_NAMES, 2026, 4)).toEqual({
      류익선: ['2026-04-14'],
      김태식: ['2026-04-09'],
    })
    expect(parseSupportVisits(lines, SUPPORT_NAMES, 2026, 8)).toEqual({
      류익선: ['2026-08-11'],
      김태식: ['2026-08-13'],
    })
  })

  it('인당 방문 5일 — 회차 전체 10회', () => {
    const total = Object.keys(EXPECTED_DAYS).reduce((sum, month) => {
      const r = parseSupportVisits(lines, SUPPORT_NAMES, 2026, Number(month))
      return sum + (r.류익선?.length ?? 0) + (r.김태식?.length ?? 0)
    }, 0)
    expect(total).toBe(10)
  })

  // 문서 상단 "대상 기간 2026-04-01 ~ …" 줄을 방문일로 잡으면 출장 횟수가 부풀려진다
  it('대상 기간 줄을 방문일로 오인하지 않는다', () => {
    expect(parseSupportVisits(lines, SUPPORT_NAMES, 2026, 3)).toEqual({})
  })
})
