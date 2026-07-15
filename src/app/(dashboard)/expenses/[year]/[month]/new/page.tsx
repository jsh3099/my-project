import Link from 'next/link'
import { redirect, notFound } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { ExpenseForm } from '@/components/expenses/ExpenseForm'
import type { Site, SiteParameters, Profile } from '@/types'

interface Props {
  params: Promise<{ year: string; month: string }>
}

export default async function NewExpensePage({ params }: Props) {
  const { year: yearStr, month: monthStr } = await params
  const year = parseInt(yearStr, 10)
  const month = parseInt(monthStr, 10)

  if (isNaN(year) || isNaN(month) || month < 1 || month > 12) notFound()

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  // 사용자 소속 현장 조회
  const { data: assignments } = await supabase
    .from('user_site_assignments')
    .select('site_id, sites(id, name, client_name, contract_start, contract_end, contract_amount, direct_expense_budget, status, created_by, created_at, updated_at, deleted_at)')
    .eq('user_id', user.id)
    .eq('is_active', true)

  const sites = ((assignments ?? []).map((a) => a.sites).filter(Boolean) as unknown) as Site[]
  const siteIds = sites.map((s) => s.id)

  // 현장별 파라미터 조회
  const { data: paramsRows } = siteIds.length
    ? await supabase.from('site_parameters').select('*').in('site_id', siteIds)
    : { data: [] }

  const paramsMap: Record<string, SiteParameters> = {}
  for (const p of paramsRows ?? []) {
    paramsMap[p.site_id] = p as SiteParameters
  }

  // 현장별 배정 인원 로드 (출장비·현지사무원비 등 대상자 선택용, admin client로 RLS 우회)
  const staffBySite: Record<string, Profile[]> = {}
  if (siteIds.length > 0) {
    const admin = createAdminClient()
    const { data: assignmentsData } = await admin
      .from('user_site_assignments')
      .select('site_id, user_id')
      .in('site_id', siteIds)
      .eq('is_active', true)

    const userIds = [...new Set((assignmentsData ?? []).map((a) => a.user_id))]
    let profilesById: Record<string, Profile> = {}
    if (userIds.length > 0) {
      const { data: profilesData } = await admin
        .from('profiles')
        .select('*')
        .in('id', userIds)
        .eq('is_active', true)
      profilesById = Object.fromEntries((profilesData ?? []).map((p) => [p.id, p as Profile]))
    }
    for (const a of assignmentsData ?? []) {
      const profile = profilesById[a.user_id]
      if (!profile) continue
      staffBySite[a.site_id] = [...(staffBySite[a.site_id] ?? []), profile]
    }
  }

  return (
    <div className="p-8 max-w-2xl mx-auto">
      <div className="mb-6">
        <Link href={`/expenses/${year}/${month}`} className="text-sm text-blue-600 hover:underline">
          ← {year}년 {month}월 목록으로
        </Link>
        <h1 className="text-xl font-bold text-gray-900 mt-1">비용 입력</h1>
        <p className="text-sm text-gray-500">{year}년 {month}월</p>
      </div>

      <div className="rounded-lg border border-gray-200 bg-white p-6">
        <ExpenseForm
          sites={sites}
          paramsMap={paramsMap}
          userId={user.id}
          staffBySite={staffBySite}
        />
      </div>
    </div>
  )
}
