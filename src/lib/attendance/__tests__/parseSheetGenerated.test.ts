import { describe, it, expect, beforeAll } from 'vitest'
import fs from 'fs'
import path from 'path'
import { extractPdfLines, parseResidentDays } from '../parseSheet'

// 사용자 배포용 테스트 출근부(바탕화면 테스트증빙_5회차 폴더)가 파서와 계속 맞는지 확인한다.
// 명부 이름을 바꾸면(정상운 → 성혁기) 이 파일도 함께 다시 만들어야 한다.
const SHEET = 'C:/Users/user/Desktop/테스트증빙_5회차/1.테스트_출근부_상주_2026-04~08.pdf'
const NAMES = ['강희철', '성혁기']

describe.skipIf(!fs.existsSync(SHEET))('배포용 테스트 출근부 (상주 2026-04~08)', () => {
  let lines: string[]

  beforeAll(async () => {
    lines = await extractPdfLines(new Uint8Array(fs.readFileSync(path.normalize(SHEET))))
  })

  it('월별 출근일수를 인원별로 인식한다 (합계 106일)', () => {
    const expected: Record<number, number> = { 4: 22, 5: 19, 6: 22, 7: 23, 8: 20 }
    let total = 0
    for (const [month, days] of Object.entries(expected)) {
      const result = parseResidentDays(lines, NAMES, 2026, Number(month))
      expect(result, `2026-${month}월`).toEqual({ 강희철: days, 성혁기: days })
      total += days
    }
    expect(total).toBe(106)
  })

  // 총괄표 헤더에 두 이름이 모두 있으므로, 명부 순서가 달라도 열 순서를 헤더에서 잡아낸다
  it('명부 순서가 표와 달라도 열을 이름으로 맞춘다', () => {
    const result = parseResidentDays(lines, ['성혁기', '강희철'], 2026, 7)
    expect(result).toEqual({ 강희철: 23, 성혁기: 23 })
  })
})
