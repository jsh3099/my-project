'use server'

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import type { StaffType } from '@/lib/constants'
import { extractPdfLines, parseResidentDays, parseSupportVisits } from '@/lib/attendance/parseSheet'

const pad = (n: number) => String(n).padStart(2, '0')

// 기간(YYYY-MM-DD ~ YYYY-MM-DD)에 걸치는 연월 목록 (최대 24개월 안전 상한)
function monthsOfPeriod(periodStart: string, periodEnd: string): string[] {
  const months: string[] = []
  const [sy, sm] = periodStart.slice(0, 7).split('-').map(Number)
  const [ey, em] = periodEnd.slice(0, 7).split('-').map(Number)
  let y = sy
  let m = sm
  while ((y < ey || (y === ey && m <= em)) && months.length < 24) {
    months.push(`${y}-${pad(m)}`)
    m += 1
    if (m > 12) {
      m = 1
      y += 1
    }
  }
  return months
}

// 출근부 저장 — 기성회차 단위. 첨부(출근부 1부)는 회차 기간의 모든 월 시트에 반영된다.
// 상주 일수는 기성기간 "합계"로 전기하며(월별 분할 없음 — 24개월 회차도 동일 UX),
// 합계는 회차 시작 월 레코드에 저장하고 나머지 월은 0으로 초기화한다.
// 주재비 폼에서 시작 월을 조회하면 이 합계가 근무일수로 프리필되어 식대·교통비 산출 근거가 된다.
// 현장이 작성·서명한 출근부 스캔이 원본 증빙이고, 여기 입력하는 일수는 그 전기(轉記)다.
export async function upsertAttendance(formData: FormData) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: '인증이 필요합니다.' }

  const site_id = formData.get('site_id') as string
  const round_id = formData.get('round_id') as string
  const staff_type = formData.get('staff_type') as StaffType

  if (!site_id || !round_id) return { error: '현장과 기성회차가 지정되지 않았습니다.' }
  if (staff_type !== 'resident' && staff_type !== 'support') {
    return { error: '출근부 구분(상주/기술지원)이 올바르지 않습니다.' }
  }

  const { data: round } = await supabase
    .from('settlement_rounds')
    .select('id, round_no, period_start, period_end')
    .eq('id', round_id)
    .eq('site_id', site_id)
    .maybeSingle()
  if (!round) return { error: '기성회차를 찾을 수 없습니다.' }
  const months = monthsOfPeriod(round.period_start, round.period_end)

  // ── 1. 첨부 파일 업로드 (영수증과 동일한 저장소, attendance/ 경로) ──
  const files = formData.getAll('sheet_files') as File[]
  const newUrls: string[] = []
  for (const file of files) {
    if (!file.size) continue
    const ext = file.name.split('.').pop()
    const path = `attendance/${site_id}/round_${round.round_no}/${staff_type}/${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`
    const { error: uploadError } = await supabase.storage
      .from('receipts')
      .upload(path, file, { contentType: file.type })
    if (uploadError) {
      console.error('Attendance sheet upload error:', uploadError)
      return { error: '출근부 파일 업로드에 실패했습니다: ' + uploadError.message }
    }
    const { data: urlData } = supabase.storage.from('receipts').getPublicUrl(path)
    newUrls.push(urlData.publicUrl)
  }

  // 기존 첨부 유지 목록 (화면에서 삭제한 파일은 제외되어 넘어온다)
  const keptUrls = (formData.getAll('kept_file_urls') as string[]).filter(Boolean)
  const fileUrls = [...keptUrls, ...newUrls]

  // ── 2. 인원별 일수/방문일 전기 (월별 레코드) ──
  // 상주: work_days_{personKey}_{YYYY-MM} / 기술지원: visit_dates_{personKey} (회차 전체 날짜 CSV)
  // personKey: m_{memberId}(명부) 또는 {userId}(레거시 계정 인원)
  type Row = {
    site_id: string
    user_id: string | null
    member_id: string | null
    year: number
    month: number
    work_days: number
    visit_dates: string[] | null
  }
  const userRows: Row[] = []
  const memberRows: Row[] = []

  function pushRow(personKey: string, ym: string, work_days: number, visit_dates: string[] | null) {
    const [year, month] = ym.split('-').map(Number)
    const isMember = personKey.startsWith('m_')
    const row: Row = {
      site_id,
      user_id: isMember ? null : personKey,
      member_id: isMember ? personKey.slice(2) : null,
      year, month, work_days, visit_dates,
    }
    ;(isMember ? memberRows : userRows).push(row)
  }

  if (staff_type === 'resident') {
    // 기성기간 총 일수(달력 기준)가 합계 입력의 상한
    const periodDays =
      Math.round(
        (new Date(round.period_end).getTime() - new Date(round.period_start).getTime()) / 86_400_000,
      ) + 1
    for (const [key, value] of formData.entries()) {
      if (!key.startsWith('work_days_')) continue
      const personKey = key.slice('work_days_'.length)
      const days = parseInt(value as string, 10)
      if (isNaN(days) || days < 0) continue
      if (days > periodDays) {
        return { error: `출근일수 합계(${days}일)가 기성기간 일수(${periodDays}일)를 넘을 수 없습니다.` }
      }
      // 합계는 시작 월에, 나머지 월은 0으로 — 과거 월별 입력 잔재가 이중 집계되지 않게 한다
      for (const ym of months) {
        pushRow(personKey, ym, ym === months[0] ? days : 0, null)
      }
    }
  } else {
    for (const [key, value] of formData.entries()) {
      if (!key.startsWith('visit_dates_')) continue
      const personKey = key.slice('visit_dates_'.length)
      const dates = (value as string)
        .split(',')
        .map((d) => d.trim())
        .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
        .sort()
      const outside = dates.filter((d) => d < round.period_start || d > round.period_end)
      if (outside.length > 0) {
        return { error: `방문일자는 기성기간(${round.period_start} ~ ${round.period_end}) 안에서만 입력할 수 있습니다: ${outside.join(', ')}` }
      }
      // 회차 기간의 모든 월에 대해 레코드를 쓴다 — 방문이 없어진 월도 비워져야 한다
      for (const ym of months) {
        const monthDates = dates.filter((d) => d.startsWith(ym))
        pushRow(personKey, ym, monthDates.length, monthDates.length > 0 ? monthDates : null)
      }
    }
  }

  // ── 3. 저장 — 첨부는 회차 기간의 모든 월 시트에 동일하게 기록 ──
  const sheetRows = months.map((ym) => {
    const [year, month] = ym.split('-').map(Number)
    return { site_id, year, month, staff_type, file_urls: fileUrls, uploaded_by: user.id }
  })
  const { error: sheetError } = await supabase
    .from('attendance_sheets')
    .upsert(sheetRows, { onConflict: 'site_id,year,month,staff_type' })
  if (sheetError) return { error: '출근부 첨부 저장에 실패했습니다: ' + sheetError.message }

  // 계정 인원과 명부 인원은 유니크 제약이 달라 upsert를 나눈다
  if (userRows.length > 0) {
    const { error } = await supabase
      .from('attendance_records')
      .upsert(userRows, { onConflict: 'site_id,user_id,year,month' })
    if (error) return { error: '출근부 저장에 실패했습니다: ' + error.message }
  }
  if (memberRows.length > 0) {
    const { error } = await supabase
      .from('attendance_records')
      .upsert(memberRows, { onConflict: 'site_id,member_id,year,month' })
    if (error) return { error: '출근부 저장에 실패했습니다: ' + error.message }
  }

  revalidatePath('/attendance')
  revalidatePath('/expenses/staff-costs/resident')
  revalidatePath('/expenses/staff-costs/support')
  return { success: true }
}

// 출근부 첨부 자동 인식 — 선택한 PDF의 텍스트에서 명부 인원별 일수(상주)/방문일(기술지원)을
// 회차 기간의 모든 월에 대해 추출해 제안값으로 돌려준다. 저장은 하지 않는다.
// 텍스트 레이어가 없는 스캔 이미지·사진은 인식하지 못한다.
export async function parseAttendanceSheet(formData: FormData) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: '인증이 필요합니다.' }

  const staff_type = formData.get('staff_type') as StaffType
  const months = ((formData.get('months') as string) ?? '')
    .split(',')
    .map((m) => m.trim())
    .filter((m) => /^\d{4}-\d{2}$/.test(m))
  let names: string[] = []
  try {
    names = JSON.parse((formData.get('names') as string) ?? '[]')
  } catch {
    names = []
  }
  if (months.length === 0 || names.length === 0) {
    return { error: '자동 인식에 필요한 정보(기성기간·명부 인원)가 없습니다.' }
  }

  const files = (formData.getAll('sheet_files') as File[]).filter((f) => f.size > 0)
  const pdfs = files.filter(
    (f) => f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf'),
  )
  if (pdfs.length === 0) {
    return { error: '자동 인식은 PDF 첨부에서만 지원됩니다. 사진·스캔 이미지는 일수를 직접 입력하세요.' }
  }

  const lines: string[] = []
  try {
    for (const f of pdfs) {
      lines.push(...(await extractPdfLines(new Uint8Array(await f.arrayBuffer()))))
    }
  } catch (e) {
    console.error('Attendance sheet parse error:', e)
    return { error: 'PDF를 읽지 못했습니다. 일수를 직접 입력하세요.' }
  }

  if (staff_type === 'resident') {
    // 월별 일수: {이름: {연월: 일수}}
    const workDays: Record<string, Record<string, number>> = {}
    for (const ym of months) {
      const [y, m] = ym.split('-').map(Number)
      const parsed = parseResidentDays(lines, names, y, m)
      for (const [name, days] of Object.entries(parsed)) {
        ;(workDays[name] ??= {})[ym] = days
      }
    }
    if (Object.keys(workDays).length === 0) {
      return { error: '첨부에서 기성기간의 출근일수를 찾지 못했습니다. 직접 입력하세요.' }
    }
    return { workDays }
  }

  // 기술지원: 회차 전체 방문일 목록 {이름: [날짜...]}
  const visitDates: Record<string, string[]> = {}
  for (const ym of months) {
    const [y, m] = ym.split('-').map(Number)
    const parsed = parseSupportVisits(lines, names, y, m)
    for (const [name, dates] of Object.entries(parsed)) {
      visitDates[name] = [...(visitDates[name] ?? []), ...dates]
    }
  }
  for (const name of Object.keys(visitDates)) visitDates[name].sort()
  if (Object.keys(visitDates).length === 0) {
    return { error: '첨부에서 기성기간의 방문일자를 찾지 못했습니다. 직접 입력하세요.' }
  }
  return { visitDates }
}

// 현장 기술인 명부에 인원 추가 (로그인 계정이 없는 상주/기술지원 기술인)
export async function addSiteStaffMember(formData: FormData) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: '인증이 필요합니다.' }

  const site_id = formData.get('site_id') as string
  const staff_type = formData.get('staff_type') as StaffType
  const name = ((formData.get('name') as string) ?? '').trim()
  const specialty = ((formData.get('specialty') as string) ?? '').trim() || null

  if (!site_id) return { error: '현장이 지정되지 않았습니다.' }
  if (staff_type !== 'resident' && staff_type !== 'support') {
    return { error: '구분(상주/기술지원)이 올바르지 않습니다.' }
  }
  if (!name) return { error: '성명을 입력하세요.' }

  const { error } = await supabase
    .from('site_staff_members')
    .insert({ site_id, staff_type, name, specialty, created_by: user.id })
  if (error) return { error: '인원 추가에 실패했습니다: ' + error.message }

  revalidatePath('/attendance')
  return { success: true }
}

// 명부 인원 제외 (비활성화 — 과거 출근부 기록은 보존)
export async function deactivateSiteStaffMember(memberId: string) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: '인증이 필요합니다.' }

  const { error } = await supabase
    .from('site_staff_members')
    .update({ is_active: false })
    .eq('id', memberId)
  if (error) return { error: '인원 제외에 실패했습니다: ' + error.message }

  revalidatePath('/attendance')
  return { success: true }
}
