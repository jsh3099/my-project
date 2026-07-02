import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { AttendanceForm } from '@/components/attendance/AttendanceForm'
import type { Site, Profile, AttendanceRecord } from '@/types'

export default async function AttendancePage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const now = new Date()
  const year = now.getFullYear()
  const month = now.getMonth() + 1

  // 현장 목록
  const { data: assignments } = await supabase
    .from('user_site_assignments')
    .select('site_id, sites(*)')
    .eq('user_id', user.id)
    .eq('is_active', true)

  const sites = ((assignments ?? []).map((a) => a.sites).filter(Boolean) as unknown) as Site[]

  // 전체 사용자 (소속 현장 사용자)
  const { data: profiles } = await supabase
    .from('profiles')
    .select('*')
    .eq('is_active', true)
    .order('full_name')

  const users = (profiles ?? []) as Profile[]

  // 기존 출근부
  const siteIds = sites.map((s) => s.id)
  const { data: existing } = siteIds.length > 0
    ? await supabase
        .from('attendance_records')
        .select('*')
        .in('site_id', siteIds)
        .eq('year', year)
        .eq('month', month)
    : { data: [] }

  return (
    <div className="p-8 max-w-2xl mx-auto">
      <div className="mb-6">
        <h1 className="text-xl font-bold text-gray-900">출근부 입력</h1>
        <p className="text-sm text-gray-500">{year}년 {month}월</p>
      </div>

      {sites.length === 0 ? (
        <div className="rounded-lg border border-gray-200 bg-white p-8 text-center text-sm text-gray-400">
          배정된 현장이 없습니다.
        </div>
      ) : (
        <div className="rounded-lg border border-gray-200 bg-white p-6">
          <AttendanceForm
            sites={sites}
            users={users}
            year={year}
            month={month}
            existing={(existing ?? []) as AttendanceRecord[]}
          />
        </div>
      )}
    </div>
  )
}
