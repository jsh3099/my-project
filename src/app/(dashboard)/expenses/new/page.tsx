import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { redirect } from 'next/navigation'
import { ExpenseForm } from '@/components/expenses/ExpenseForm'
import type { Site, SiteParameters, Profile } from '@/types'

export default async function NewExpensePage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: assignments } = await supabase
    .from('user_site_assignments')
    .select('site_id, sites(id, name, direct_expense_budget, status)')
    .eq('user_id', user.id)
    .eq('is_active', true)

  const sites = (assignments?.map((a) => a.sites).filter(Boolean) ?? []) as unknown as Site[]

  // 현장별 파라미터 로드
  const siteIds = sites.map((s) => s.id)
  let paramsMap: Record<string, SiteParameters> = {}
  if (siteIds.length > 0) {
    const { data: paramsData } = await supabase
      .from('site_parameters')
      .select('*')
      .in('site_id', siteIds)
    for (const p of paramsData ?? []) {
      paramsMap[p.site_id] = p as SiteParameters
    }
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
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <h1 className="text-xl font-bold text-gray-900">비용 입력</h1>
        <p className="mt-1 text-sm text-gray-500">비목을 선택하고 금액과 영수증을 업로드하세요.</p>
      </div>

      {sites.length === 0 ? (
        <div className="rounded-xl border border-yellow-200 bg-yellow-50 p-6 text-center">
          <p className="font-medium text-yellow-800">배정된 현장이 없습니다</p>
          <p className="mt-1 text-sm text-yellow-600">시스템 관리자에게 현장 배정을 요청하세요.</p>
        </div>
      ) : (
        <ExpenseForm sites={sites} paramsMap={paramsMap} userId={user.id} staffBySite={staffBySite} />
      )}
    </div>
  )
}
