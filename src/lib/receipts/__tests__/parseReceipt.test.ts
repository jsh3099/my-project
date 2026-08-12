import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import { extractPdfLines } from '@/lib/attendance/parseSheet'
import { parseRentTotal, parseMaintItems, parseExpenseItems, vendorFromFileName } from '../parseReceipt'

const FIXTURES = path.join(__dirname, 'fixtures')
const read = (name: string) => new Uint8Array(fs.readFileSync(path.join(FIXTURES, name)))

describe('영수증 금액 자동 인식', () => {
  it('숙소임대비: 월별 이체확인증 5장 묶음에서 이체금액을 합산한다', async () => {
    const lines = await extractPdfLines(read('rent_2026-04~08.pdf'))
    expect(parseRentTotal(lines)).toBe(2_500_000) // 500,000 × 5개월
  })

  // 표지 요약표가 "이체금액" 문구를 쓰면 월별 이체금액과 이중 합산된다.
  // 배포용 증빙에서만 검증하던 것을 커밋된 픽스처로 옮겨 어디서든 돌게 했다.
  it('숙소임대비: 표지 요약표가 이체금액 합산에 중복 계상되지 않는다', async () => {
    const lines = await extractPdfLines(read('rent_2026-04~08.pdf'))
    expect(lines.filter((l) => /이체금액\s*[\d,]+\s*원/.test(l))).toHaveLength(5)
  })

  // 임대비 문서에서 관리비(전기·가스) 항목이 잘못 잡히면 관리비 칸이 오염된다
  it('숙소임대비: 임대비 문서에서 관리비 항목은 인식되지 않는다', async () => {
    const lines = await extractPdfLines(read('rent_2026-04~08.pdf'))
    expect(parseMaintItems(lines)).toEqual([])
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

describe('현장경비 범용 영수증 인식', () => {
  it('합계 키워드·일자·상호를 뽑아 내역 1건을 제안한다', () => {
    const lines = [
      '영 수 증',
      '상호: 오피스디포 청주점 대표 김OO',
      '거래일시 2026.05.11 14:22',
      'A4용지 3박스 45,000',
      '토너 1개 61,040',
      '합 계 106,040원',
    ]
    expect(parseExpenseItems(lines)).toEqual([
      { date: '2026-05-11', vendor: '오피스디포 청주점', description: '', amountGross: 106_040 },
    ])
  })

  it('합계 키워드가 없으면 최대 금액을 후보로 쓰고, 상호는 파일명에서 추정한다', () => {
    const lines = ['주문내역', '2026-04-03', '종이컵 12,000', '복사용지 76,000']
    expect(parseExpenseItems(lines, '영수증_쿠팡_2026-04.pdf')).toEqual([
      { date: '2026-04-03', vendor: '쿠팡', description: '', amountGross: 76_000 },
    ])
  })

  it('금액이 없으면 빈 결과 — 스캔 이미지 폴백과 같은 처리', () => {
    expect(parseExpenseItems(['현 장 사 진', '2026-06-01 촬영'])).toEqual([])
  })

  it('파일명 구매처 추정: 날짜·일반어 토큰을 걷어낸다', () => {
    expect(vendorFromFileName('영수증_문구몰_2026-05.pdf')).toBe('문구몰')
    expect(vendorFromFileName('세금계산서_토너.pdf')).toBe('토너')
    expect(vendorFromFileName('scan001.pdf')).toBe('scan001')
  })
})
