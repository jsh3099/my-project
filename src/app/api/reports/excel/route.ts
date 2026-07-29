// 정산서 엑셀 다운로드 — GET /api/reports/excel?site=<siteId>&round=<roundId?>
// round 미지정 시 진행 중(미편입) 지출의 잠정 정산서를 생성한다.

import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { getSettlementReportData } from '@/lib/reports/reportData'
import { buildSettlementWorkbook } from '@/lib/reports/excel'

export const runtime = 'nodejs'

export async function GET(request: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: '로그인이 필요합니다.' }, { status: 401 })

  const { searchParams } = new URL(request.url)
  const siteId = searchParams.get('site')
  const roundId = searchParams.get('round')
  if (!siteId) return NextResponse.json({ error: 'site 파라미터가 필요합니다.' }, { status: 400 })

  const admin = createAdminClient()

  // 접근 권한: 본사/관리자 또는 해당 현장 배정 인원 (정산서는 현장 직원이 작성·제출)
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
    if (!assignment) return NextResponse.json({ error: '해당 현장에 배정되지 않았습니다.' }, { status: 403 })
  }

  const data = await getSettlementReportData(admin, siteId, roundId)
  if ('error' in data) return NextResponse.json({ error: data.error }, { status: 400 })

  const wb = buildSettlementWorkbook(data)
  const buffer = await wb.xlsx.writeBuffer()

  const roundLabel = data.round ? `${data.round.round_no}회차` : '잠정'
  const fileName = `${data.site.name}_직접경비정산서_${roundLabel}.xlsx`

  return new NextResponse(buffer as ArrayBuffer, {
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      // RFC 5987 — 한글 파일명은 filename*로, ASCII fallback은 filename으로
      'Content-Disposition': `attachment; filename="settlement.xlsx"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
    },
  })
}
