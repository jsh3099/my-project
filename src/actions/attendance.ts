'use server'

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import type { StaffType, ResidenceType } from '@/lib/constants'
import { extractPdfLines, parseResidentDays, parseSupportVisits } from '@/lib/attendance/parseSheet'
import { parseResidenceAddress } from '@/lib/receipts/parseReceipt'

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
    // 원본 파일명은 URL 프래그먼트로 함께 보관한다 — 화면 첨부 칩이 "어떤 출근부인지" 보여줘야 하는데,
    // 스토리지 키에는 한글·`~`를 넣을 수 없다(Invalid key). 프래그먼트는 서버로 전송되지 않아
    // 링크 열기·다운로드에는 영향이 없다.
    newUrls.push(`${urlData.publicUrl}#${encodeURIComponent(file.name)}`)
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

  // 거주 형태 — 상주만 의미가 있다 (기술지원은 출장비로 정산)
  const residenceRaw = formData.get('residence_type') as string | null
  const residence_type: ResidenceType = residenceRaw === 'commute' ? 'commute' : 'lodging'

  const { error } = await supabase
    .from('site_staff_members')
    .insert({ site_id, staff_type, name, specialty, residence_type, created_by: user.id })
  if (error) return { error: '인원 추가에 실패했습니다: ' + error.message }

  revalidatePath('/attendance')
  return { success: true }
}

// 명부 거주 형태 변경 — 주재비 폼의 회차별 실효값(commuteMode)과 달리 인원의 기본값을 바꾼다
export async function updateSiteStaffResidence(memberId: string, residenceType: ResidenceType) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: '인증이 필요합니다.' }
  if (residenceType !== 'lodging' && residenceType !== 'commute') {
    return { error: '거주 형태가 올바르지 않습니다.' }
  }

  const { error } = await supabase
    .from('site_staff_members')
    .update({ residence_type: residenceType })
    .eq('id', memberId)
  if (error) return { error: '거주 형태 변경에 실패했습니다: ' + error.message }

  revalidatePath('/attendance')
  revalidatePath('/expenses/staff-costs/resident')
  return { success: true }
}

// 거주지 증빙 첨부 (재직증명서·주민등록등본 등) — 명부 인원 단위.
// 교통비(자택↔현장 거리) 산출의 자택주소를 뒷받침하는 서류라 회차가 아닌 사람에 딸린다.
// 한 번 첨부하면 모든 회차에 적용되고, 주소 변경 시에만 교체한다.
export async function uploadResidenceDoc(memberId: string, formData: FormData) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: '인증이 필요합니다.' }

  const { data: member } = await supabase
    .from('site_staff_members')
    .select('id, site_id, residence_doc_urls, home_address')
    .eq('id', memberId)
    .maybeSingle()
  if (!member) return { error: '명부 인원을 찾을 수 없습니다.' }

  const files = (formData.getAll('doc_files') as File[]).filter((f) => f.size > 0)
  if (files.length === 0) return { error: '첨부할 파일을 선택하세요.' }

  const newUrls: string[] = []
  for (const file of files) {
    const ext = file.name.split('.').pop()
    const path = `staff-docs/${member.site_id}/${member.id}/${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`
    const { error: uploadError } = await supabase.storage
      .from('receipts')
      .upload(path, file, { contentType: file.type })
    if (uploadError) {
      console.error('Residence doc upload error:', uploadError)
      return { error: '거주지 증빙 업로드에 실패했습니다: ' + uploadError.message }
    }
    const { data: urlData } = supabase.storage.from('receipts').getPublicUrl(path)
    // 원본 파일명은 URL 프래그먼트로 보관 (출근부 첨부와 같은 관례 — 스토리지 키에 한글 불가)
    newUrls.push(`${urlData.publicUrl}#${encodeURIComponent(file.name)}`)
  }

  // 첨부 PDF에서 자택주소를 인식해 채운다 — 교통비·출장비 산출의 출발지가 되는 값이라
  // 증빙과 같은 서류에서 옮겨 적는 수고를 없앤다. 이미 주소가 있으면 덮어쓰지 않는다
  // (사용자가 고쳐둔 값이 인식값에 밀리면 안 된다). 인식 실패는 오류가 아니다 — 직접 입력하면 된다.
  let parsedAddress = ''
  if (!member.home_address) {
    const pdfs = files.filter(
      (f) => f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf'),
    )
    try {
      for (const f of pdfs) {
        const lines = await extractPdfLines(new Uint8Array(await f.arrayBuffer()))
        parsedAddress = parseResidenceAddress(lines)
        if (parsedAddress) break
      }
    } catch (e) {
      console.error('Residence doc address parse error:', e)
    }
  }

  const { error } = await supabase
    .from('site_staff_members')
    .update({
      residence_doc_urls: [...(member.residence_doc_urls ?? []), ...newUrls],
      ...(parsedAddress ? { home_address: parsedAddress } : {}),
    })
    .eq('id', memberId)
  if (error) return { error: '거주지 증빙 저장에 실패했습니다: ' + error.message }

  revalidatePath('/attendance')
  revalidatePath('/expenses/staff-costs/resident')
  revalidatePath('/expenses/staff-costs/support')
  return { success: true, parsedAddress }
}

// 저장된 공개 URL에서 스토리지 경로를 되돌린다 (#원본파일명 프래그먼트 제거)
function storagePathFromUrl(url: string): string | null {
  const bare = url.split('#')[0]
  const marker = '/object/public/receipts/'
  const i = bare.indexOf(marker)
  if (i < 0) return null
  return decodeURIComponent(bare.slice(i + marker.length))
}

// 이미 첨부된 거주지 증빙에서 자택주소를 다시 인식한다.
// 첨부는 업로드 시점에만 인식하므로, 기능이 없던 때 올린 증빙이나 인식 실패분을 위해 필요하다.
export async function reparseResidenceAddress(memberId: string) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: '인증이 필요합니다.' }

  // 멤버 조회는 사용자 권한(RLS)으로 — 볼 수 있는 인원의 증빙만 다시 읽는다
  const { data: member } = await supabase
    .from('site_staff_members')
    .select('id, residence_doc_urls')
    .eq('id', memberId)
    .maybeSingle()
  if (!member) return { error: '명부 인원을 찾을 수 없습니다.' }

  const urls = (member.residence_doc_urls ?? []).filter((u: string) =>
    u.split('#')[0].toLowerCase().endsWith('.pdf'),
  )
  if (urls.length === 0) {
    return { error: '인식할 PDF 증빙이 없습니다. 주소를 직접 입력하세요. (사진·스캔 이미지는 인식 대상이 아닙니다)' }
  }

  // 저장소는 비공개라 공개 URL로는 못 읽는다 — 서비스 권한으로 내려받아 텍스트만 추출한다
  const admin = createAdminClient()
  let parsed = ''
  for (const url of urls) {
    const path = storagePathFromUrl(url)
    if (!path) continue
    const { data: blob, error: dlError } = await admin.storage.from('receipts').download(path)
    if (dlError || !blob) {
      console.error('Residence doc download error:', dlError)
      continue
    }
    try {
      const lines = await extractPdfLines(new Uint8Array(await blob.arrayBuffer()))
      parsed = parseResidenceAddress(lines)
      if (parsed) break
    } catch (e) {
      console.error('Residence doc reparse error:', e)
    }
  }
  if (!parsed) {
    return { error: '증빙에서 주소를 찾지 못했습니다. 주소를 직접 입력하세요.' }
  }

  const { error } = await supabase
    .from('site_staff_members')
    .update({ home_address: parsed })
    .eq('id', memberId)
  if (error) return { error: '자택주소 저장에 실패했습니다: ' + error.message }

  revalidatePath('/attendance')
  revalidatePath('/expenses/staff-costs/resident')
  revalidatePath('/expenses/staff-costs/support')
  return { success: true, parsedAddress: parsed }
}

// 자택주소 직접 입력·수정 — 인식값이 틀렸거나 증빙이 이미지(스캔)일 때 쓴다
export async function updateStaffHomeAddress(memberId: string, address: string) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: '인증이 필요합니다.' }

  const value = address.trim()
  if (value.length > 200) return { error: '자택주소가 너무 깁니다.' }

  const { error } = await supabase
    .from('site_staff_members')
    .update({ home_address: value || null })
    .eq('id', memberId)
  if (error) return { error: '자택주소 저장에 실패했습니다: ' + error.message }

  revalidatePath('/attendance')
  revalidatePath('/expenses/staff-costs/resident')
  revalidatePath('/expenses/staff-costs/support')
  return { success: true }
}

// 거주지 증빙 제거 — 잘못 올린 파일 교체용 (스토리지 원본은 보존, 참조만 끊는다)
export async function removeResidenceDoc(memberId: string, url: string) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: '인증이 필요합니다.' }

  const { data: member } = await supabase
    .from('site_staff_members')
    .select('id, residence_doc_urls')
    .eq('id', memberId)
    .maybeSingle()
  if (!member) return { error: '명부 인원을 찾을 수 없습니다.' }

  const { error } = await supabase
    .from('site_staff_members')
    .update({ residence_doc_urls: (member.residence_doc_urls ?? []).filter((u: string) => u !== url) })
    .eq('id', memberId)
  if (error) return { error: '거주지 증빙 제거에 실패했습니다: ' + error.message }

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
