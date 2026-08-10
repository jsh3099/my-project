import { describe, it, expect, beforeAll } from 'vitest'
import fs from 'fs'
import path from 'path'
import { extractPdfLines, parseResidentDays, parseSupportVisits } from '../parseSheet'

// 픽스처: 테스트용 통합 출근부 (2026-04 ~ 2026-08, 도매시장 5회차 샌드박스)
const FIXTURES = path.join(__dirname, 'fixtures')
const RESIDENT_NAMES = ['강희철', '성혁기']
const SUPPORT_NAMES = ['류익선', '장재근']

function readFixture(name: string): Uint8Array {
  return new Uint8Array(fs.readFileSync(path.join(FIXTURES, name)))
}

describe('출근부 PDF 자동 인식', () => {
  let residentLines: string[]
  let supportLines: string[]

  beforeAll(async () => {
    residentLines = await extractPdfLines(readFixture('resident_2026-04~08.pdf'))
    supportLines = await extractPdfLines(readFixture('support_2026-04~08.pdf'))
  })

  it('상주: 통합본에서 월별 출근일수를 인원별로 추출한다', () => {
    const expected: Record<number, number> = { 4: 22, 5: 19, 6: 22, 7: 23, 8: 20 }
    for (const [month, days] of Object.entries(expected)) {
      const result = parseResidentDays(residentLines, RESIDENT_NAMES, 2026, Number(month))
      expect(result, `2026-${month}월`).toEqual({ 강희철: days, 성혁기: days })
    }
  })

  it('상주: 문서에 없는 연월은 빈 결과를 돌려준다', () => {
    expect(parseResidentDays(residentLines, RESIDENT_NAMES, 2026, 3)).toEqual({})
  })

  it('상주: 대상 기간 표기(2026-04-01 ~)를 일수로 오인하지 않는다', () => {
    const result = parseResidentDays(residentLines, RESIDENT_NAMES, 2026, 4)
    expect(result.강희철).toBe(22) // 기간 행이 아니라 총괄표 행에서 읽어야 함
  })

  it('기술지원: 해당 월의 방문일자만 인원별로 추출한다', () => {
    const jul = parseSupportVisits(supportLines, SUPPORT_NAMES, 2026, 7)
    expect(jul).toEqual({
      류익선: ['2026-07-14', '2026-07-28'],
      장재근: ['2026-07-09', '2026-07-23'],
    })
    const apr = parseSupportVisits(supportLines, SUPPORT_NAMES, 2026, 4)
    expect(apr).toEqual({
      류익선: ['2026-04-14', '2026-04-28'],
      장재근: ['2026-04-09', '2026-04-23'],
    })
  })

  it('기술지원: 문서에 없는 연월은 빈 결과를 돌려준다', () => {
    expect(parseSupportVisits(supportLines, SUPPORT_NAMES, 2026, 3)).toEqual({})
  })
})
