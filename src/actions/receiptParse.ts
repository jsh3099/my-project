'use server'

import { createClient } from '@/lib/supabase/server'
import { extractPdfLines } from '@/lib/attendance/parseSheet'
import { parseRentTotal, parseMaintItems, parseExpenseItems, type ParsedMaintItem, type ParsedExpenseItem } from '@/lib/receipts/parseReceipt'

// 주재비 폼 영수증 첨부 자동 인식 — 저장 없이 인식값만 돌려준다(사용자 확인 후 저장 흐름).
// 숙소임대비: 이체확인증 이체금액 합산 / 관리비: 전기·가스 건별 내역.
// 텍스트 레이어가 없는 스캔 이미지·사진은 인식하지 못한다.
export async function parseReceiptAmounts(
  formData: FormData,
): Promise<{ error: string } | { rentTotal: number; maintItems: ParsedMaintItem[] }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: '인증이 필요합니다.' }

  const files = (formData.getAll('files') as File[]).filter(
    (f) => f.size > 0 && (f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf')),
  )
  if (files.length === 0) {
    return { error: '자동 인식은 PDF 첨부에서만 지원됩니다. 금액을 직접 입력하세요.' }
  }

  const lines: string[] = []
  try {
    for (const f of files) {
      lines.push(...(await extractPdfLines(new Uint8Array(await f.arrayBuffer()))))
    }
  } catch (e) {
    console.error('Receipt parse error:', e)
    return { error: 'PDF를 읽지 못했습니다. 금액을 직접 입력하세요.' }
  }

  return { rentTotal: parseRentTotal(lines), maintItems: parseMaintItems(lines) }
}

// 현장경비 영수증 자동 인식 — 파일별로 금액·일자·구매처(추정)를 뽑아 내역 행을 제안한다.
// 양식이 제각각이라 확실한 것(합계 금액·첫 날짜)만 채우고 나머지는 사용자가 입력한다.
export async function parseExpenseReceipt(
  formData: FormData,
): Promise<{ error: string } | { items: ParsedExpenseItem[] }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: '인증이 필요합니다.' }

  const files = (formData.getAll('files') as File[]).filter(
    (f) => f.size > 0 && (f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf')),
  )
  if (files.length === 0) {
    return { error: '자동 인식은 PDF 첨부에서만 지원됩니다. 내역을 직접 입력하세요.' }
  }

  const items: ParsedExpenseItem[] = []
  try {
    for (const f of files) {
      const lines = await extractPdfLines(new Uint8Array(await f.arrayBuffer()))
      items.push(...parseExpenseItems(lines, f.name))
    }
  } catch (e) {
    console.error('Expense receipt parse error:', e)
    return { error: 'PDF를 읽지 못했습니다. 내역을 직접 입력하세요.' }
  }
  return { items }
}
