'use server'

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import type { StaffType } from '@/lib/constants'

// 출근부 저장 — 상주/기술지원 구분 단위로 첨부 파일 + 인원별 일수(방문일)를 함께 저장한다.
// 현장이 작성·서명한 출근부 스캔이 원본 증빙이고, 여기 입력하는 일수는 그 전기(轉記)다.
export async function upsertAttendance(formData: FormData) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: '인증이 필요합니다.' }

  const site_id = formData.get('site_id') as string
  const year = parseInt(formData.get('year') as string, 10)
  const month = parseInt(formData.get('month') as string, 10)
  const staff_type = formData.get('staff_type') as StaffType

  if (!site_id || isNaN(year) || isNaN(month)) {
    return { error: '현장, 연도, 월은 필수입니다.' }
  }
  if (staff_type !== 'resident' && staff_type !== 'support') {
    return { error: '출근부 구분(상주/기술지원)이 올바르지 않습니다.' }
  }

  // ── 1. 첨부 파일 업로드 (영수증과 동일한 저장소, attendance/ 경로) ──
  const files = formData.getAll('sheet_files') as File[]
  const newUrls: string[] = []
  for (const file of files) {
    if (!file.size) continue
    const ext = file.name.split('.').pop()
    const path = `attendance/${site_id}/${year}-${String(month).padStart(2, '0')}/${staff_type}/${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`
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

  // ── 2. 인원별 일수/방문일 전기 ──
  // 인원 키: work_days_{userId} / work_days_m_{memberId} (상주),
  //          visit_dates_{userId} / visit_dates_m_{memberId} (기술지원)
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

  function pushRow(personKey: string, work_days: number, visit_dates: string[] | null) {
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
    for (const [key, value] of formData.entries()) {
      if (!key.startsWith('work_days_')) continue
      const personKey = key.replace('work_days_', '')
      const days = parseInt(value as string, 10)
      if (!isNaN(days) && days >= 0 && days <= 31) {
        pushRow(personKey, days, null)
      }
    }
  } else {
    // "2026-07-08,2026-07-15" — 기술지원 일수는 방문일 수로 산출
    const ym = `${year}-${String(month).padStart(2, '0')}`
    for (const [key, value] of formData.entries()) {
      if (!key.startsWith('visit_dates_')) continue
      const personKey = key.replace('visit_dates_', '')
      const dates = (value as string)
        .split(',')
        .map((d) => d.trim())
        .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
        .sort()
      if (dates.some((d) => !d.startsWith(ym))) {
        return { error: `방문일자는 ${year}년 ${month}월 안에서만 입력할 수 있습니다.` }
      }
      pushRow(personKey, dates.length, dates.length > 0 ? dates : null)
    }
  }

  // ── 3. 저장 ──
  const { error: sheetError } = await supabase
    .from('attendance_sheets')
    .upsert(
      { site_id, year, month, staff_type, file_urls: fileUrls, uploaded_by: user.id },
      { onConflict: 'site_id,year,month,staff_type' },
    )
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
