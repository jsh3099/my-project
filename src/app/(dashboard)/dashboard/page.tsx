import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'

export default async function DashboardPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: profile } = await supabase
    .from('profiles')
    .select('role, full_name')
    .eq('id', user.id)
    .single()

  return (
    <div className="space-y-4">
      <h2 className="text-xl font-semibold text-gray-900">
        안녕하세요, {profile?.full_name}님
      </h2>
      <p className="text-sm text-gray-500">
        직접경비 정산 플랫폼에 오신 것을 환영합니다.
      </p>
      <div className="rounded-lg border border-gray-200 bg-white p-6 text-sm text-gray-600">
        현장 직원용 비용 입력 기능은 2단계(F-05~F-11)에서 구현됩니다.
      </div>
    </div>
  )
}
