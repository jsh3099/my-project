// 증빙 원본 열람 — GET /api/receipts?p=<DB에 저장된 증빙 값>
//
// `receipts` 버킷은 비공개이므로, 권한을 확인한 뒤 여기서 단기 서명 URL을 발급해 302로 넘긴다.
// 화면의 `<a href>`는 모두 이 라우트를 가리킨다(`receiptHref()`) — 만료되는 서명 URL을
// DB나 HTML에 박아두지 않는 것이 핵심이다.
//
// 권한 기준은 정산서 출력 라우트(`/api/reports/*`)와 같다: **본사/관리자는 전체,
// 현장직원은 배정된 현장의 증빙만**. `expenses` RLS(`submitted_by = auth.uid()`)를
// 그대로 쓰지 않는 이유는, 주재비·현장경비 화면 자체가 admin 클라이언트로 현장 전체의
// draft를 불러 한 현장 인원이 서로의 증빙을 함께 확인하는 구조이기 때문이다.
// RLS를 그대로 적용하면 화면에는 보이는 첨부가 열리지 않는 어긋남이 생긴다.
//
// 어느 행에서도 참조되지 않는 경로는 거부한다 — 저장소를 훑어보는 것을 막는다.

import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  RECEIPTS_BUCKET,
  RECEIPT_SIGN_TTL_SEC,
  receiptStoragePath,
} from '@/lib/storage/receipts'

export const runtime = 'nodejs'

// 저장값을 참조하는 행을 찾아 소유 현장을 알아낸다.
// 저장값은 배열 컬럼에 그대로 들어 있으므로 정확 일치(contains)로 찾는다 —
// 신규(경로)·레거시(공개 URL) 어느 형식이든 화면이 받은 값을 그대로 되돌려 보내므로 맞는다.
async function findOwningSite(
  admin: SupabaseClient,
  stored: string,
): Promise<string | null> {
  const lookups: [string, string][] = [
    ['expenses', 'receipt_urls'],
    ['attendance_sheets', 'file_urls'],
    ['site_staff_members', 'residence_doc_urls'],
  ]
  for (const [table, column] of lookups) {
    const { data, error } = await admin
      .from(table)
      .select('site_id')
      .contains(column, [stored])
      .limit(1)
      .maybeSingle()
    if (error) {
      console.error(`[receipts] ${table}.${column} 조회 실패:`, error.message)
      continue
    }
    if (data?.site_id) return data.site_id as string
  }
  return null
}

export async function GET(request: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: '로그인이 필요합니다.' }, { status: 401 })

  const stored = new URL(request.url).searchParams.get('p')
  if (!stored) return NextResponse.json({ error: 'p 파라미터가 필요합니다.' }, { status: 400 })

  const path = receiptStoragePath(stored)
  if (!path) {
    return NextResponse.json({ error: '증빙 주소를 읽을 수 없습니다.' }, { status: 400 })
  }

  const admin = createAdminClient()

  const siteId = await findOwningSite(admin, stored)
  if (!siteId) {
    // 참조가 없으면 이미 삭제된 첨부이거나 조작된 주소다
    return NextResponse.json({ error: '증빙을 찾을 수 없습니다.' }, { status: 404 })
  }

  const { data: profile } = await admin.from('profiles').select('role').eq('id', user.id).single()
  if (!profile) return NextResponse.json({ error: '프로필을 찾을 수 없습니다.' }, { status: 403 })
  if (profile.role === 'site_staff') {
    const { data: assignment } = await admin
      .from('user_site_assignments')
      .select('id')
      .eq('user_id', user.id)
      .eq('site_id', siteId)
      .eq('is_active', true)
      .maybeSingle()
    if (!assignment) {
      return NextResponse.json({ error: '해당 현장의 증빙이 아닙니다.' }, { status: 403 })
    }
  }

  const { data: signed, error: signError } = await admin.storage
    .from(RECEIPTS_BUCKET)
    .createSignedUrl(path, RECEIPT_SIGN_TTL_SEC)
  if (signError || !signed?.signedUrl) {
    console.error('[receipts] 서명 URL 발급 실패:', path, signError?.message)
    return NextResponse.json(
      { error: '증빙 파일을 열 수 없습니다. 파일이 삭제되었을 수 있습니다.' },
      { status: 404 },
    )
  }

  // 서명 URL은 만료되므로 캐시하지 않는다 — 캐시된 302를 재사용하면 만료 후 열리지 않는다
  return NextResponse.redirect(signed.signedUrl, {
    status: 302,
    headers: { 'Cache-Control': 'no-store' },
  })
}
