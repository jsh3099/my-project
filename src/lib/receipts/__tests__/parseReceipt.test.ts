import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import { extractPdfLines } from '@/lib/attendance/parseSheet'
import { parseRentTotal, parseMaintItems } from '../parseReceipt'

const FIXTURES = path.join(__dirname, 'fixtures')
const read = (name: string) => new Uint8Array(fs.readFileSync(path.join(FIXTURES, name)))

describe('영수증 금액 자동 인식', () => {
  it('숙소임대비: 월별 이체확인증 5장 묶음에서 이체금액을 합산한다', async () => {
    const lines = await extractPdfLines(read('rent_2026-04~08.pdf'))
    expect(parseRentTotal(lines)).toBe(2_500_000) // 500,000 × 5개월
  })

  it('관리비: 단월 납입확인서에서 전기·가스 건별 내역을 추출한다', async () => {
    const lines = await extractPdfLines(read('maint_single_2026-07.pdf'))
    const items = parseMaintItems(lines)
    expect(items).toEqual([
      { date: '2026-07-10', tag: '전기', amountGross: 120_140 },
      { date: '2026-07-20', tag: '가스', amountGross: 58_100 },
    ])
  })

  it('관리비: 기간 통합 표(월 행 형식)도 전기·가스로 분해한다', () => {
    const lines = ['관리비 납입확인서 (기간 통합)', '2026-04 88,340 72,400 160,740', '합 계 539,770 302,400 842,170']
    expect(parseMaintItems(lines)).toEqual([
      { date: '2026-04-10', tag: '전기', amountGross: 88_340 },
      { date: '2026-04-20', tag: '가스', amountGross: 72_400 },
    ])
  })

  it('금액 표기가 없는 문서는 빈 결과를 돌려준다', async () => {
    expect(parseRentTotal(['출 근 부 (상주기술인)', '근무일수 합계 22일'])).toBe(0)
    expect(parseMaintItems(['영 수 증', '품목 금액', 'A4용지 5박스 32,000'])).toEqual([])
  })
})
