import { describe, it, expect } from 'vitest'
import {
  isImageReceipt,
  receiptFileName,
  receiptHref,
  receiptStoragePath,
  receiptStoredValue,
} from '../receipts'

// 하위호환이 이 파서의 존재 이유다 — 버킷을 비공개로 두고 getPublicUrl()을 쓰던 시절의
// 저장값이 DB에 이미 쌓여 있고, 그 값을 마이그레이션 없이 그대로 열 수 있어야 한다.
const LEGACY_BASE = 'https://ynbfkpydwpgqhehsixvx.supabase.co/storage/v1/object/public/receipts/'

describe('증빙 저장값 → 스토리지 경로', () => {
  it('신규 형식(경로)을 그대로 읽는다', () => {
    expect(receiptStoragePath('receipts/u1/1755000000000_ab12.pdf')).toBe(
      'receipts/u1/1755000000000_ab12.pdf',
    )
  })

  it('신규 형식의 원본파일명 프래그먼트는 경로에서 제거된다', () => {
    const stored = receiptStoredValue('receipts/u1/1755_ab.pdf', '테스트_출근부_2026-04~08.pdf')
    expect(receiptStoragePath(stored)).toBe('receipts/u1/1755_ab.pdf')
  })

  it('레거시 공개 URL에서 경로를 되돌린다 (기존 첨부가 다시 열리는 근거)', () => {
    expect(receiptStoragePath(`${LEGACY_BASE}receipts/u1/1750_cd.pdf`)).toBe(
      'receipts/u1/1750_cd.pdf',
    )
  })

  it('레거시 URL + 프래그먼트도 경로만 남는다', () => {
    const stored = `${LEGACY_BASE}attendance/s1/round_5/resident/1750_ef.pdf#${encodeURIComponent('출근부 상주.pdf')}`
    expect(receiptStoragePath(stored)).toBe('attendance/s1/round_5/resident/1750_ef.pdf')
  })

  it('URL 인코딩된 레거시 경로를 디코딩한다', () => {
    expect(receiptStoragePath(`${LEGACY_BASE}staff-docs/s1/m1/1750_gh%20i.pdf`)).toBe(
      'staff-docs/s1/m1/1750_gh i.pdf',
    )
  })

  it('서명 URL이 들어와도 경로를 읽는다 (토큰 제거)', () => {
    const signed = `https://x.supabase.co/storage/v1/object/sign/receipts/receipts/u1/1750_jk.pdf?token=eyJhbG.ci`
    expect(receiptStoragePath(signed)).toBe('receipts/u1/1750_jk.pdf')
  })

  it('우리 버킷이 아닌 외부 URL은 서명하지 않는다', () => {
    expect(receiptStoragePath('https://example.com/evil.pdf')).toBeNull()
  })

  it('경로 탈출은 거부한다 — 저장값은 사용자가 되돌려 보낼 수 있다', () => {
    expect(receiptStoragePath('receipts/../../secret.pdf')).toBeNull()
    expect(receiptStoragePath('..')).toBeNull()
  })

  it('빈 값은 null', () => {
    expect(receiptStoragePath('')).toBeNull()
    expect(receiptStoragePath('   ')).toBeNull()
    expect(receiptStoragePath('#name.pdf')).toBeNull()
  })
})

describe('첨부 표시 이름', () => {
  it('프래그먼트의 원본 파일명을 쓴다 — 스토리지 키에 한글을 넣을 수 없어서 생긴 규약', () => {
    const stored = receiptStoredValue('receipts/u1/1755_ab.pdf', '테스트_출근부_2026-04~08.pdf')
    expect(receiptFileName(stored)).toBe('테스트_출근부_2026-04~08.pdf')
  })

  it('프래그먼트가 없으면 경로 마지막 조각으로 폴백한다', () => {
    expect(receiptFileName('receipts/u1/1755_ab.pdf')).toBe('1755_ab.pdf')
  })

  it('이름을 전혀 알 수 없으면 기본 라벨', () => {
    expect(receiptFileName('')).toBe('첨부파일')
  })
})

describe('열람 주소', () => {
  it('프래그먼트가 잘리지 않도록 저장값 전체를 인코딩한다', () => {
    const stored = receiptStoredValue('receipts/u1/1755_ab.pdf', '이체확인증.pdf')
    const href = receiptHref(stored)
    expect(href.startsWith('/api/receipts?p=')).toBe(true)
    expect(href).not.toContain('#')
    // 라우트가 받는 값은 저장값과 정확히 같아야 한다 (동일성 비교 키로도 쓰인다)
    expect(new URLSearchParams(href.split('?')[1]).get('p')).toBe(stored)
  })
})

describe('이미지 첨부 판별 (산출서 지도 캡처)', () => {
  it('프래그먼트가 붙어도 확장자를 읽는다', () => {
    expect(isImageReceipt('receipts/u1/1755_ab.png#지도.png')).toBe(true)
    expect(isImageReceipt('receipts/u1/1755_ab.jpg')).toBe(true)
    expect(isImageReceipt('receipts/u1/1755_ab.jpeg#캡처.jpeg')).toBe(true)
  })

  it('PDF는 이미지가 아니다', () => {
    expect(isImageReceipt('receipts/u1/1755_ab.pdf#지도.pdf')).toBe(false)
  })
})
