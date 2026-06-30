import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { ROLE_LABELS } from '@/lib/constants'
import { Users, Plus } from 'lucide-react'

export default async function UsersPage() {
  const supabase = await createClient()

  const { data: users } = await supabase
    .from('profiles')
    .select(`
      id, email, full_name, role, is_active, created_at,
      user_site_assignments(count)
    `)
    .is('deleted_at', null)
    .order('created_at', { ascending: false })

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold text-gray-900">사용자 관리</h2>
          <p className="mt-1 text-sm text-gray-500">시스템 사용자 및 현장 배정을 관리합니다.</p>
        </div>
        <Link href="/admin/users/new">
          <Button>
            <Plus className="h-4 w-4" />
            사용자 등록
          </Button>
        </Link>
      </div>

      {(!users || users.length === 0) ? (
        <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-gray-300 bg-white py-16 text-center">
          <Users className="h-12 w-12 text-gray-300" />
          <p className="mt-3 text-sm text-gray-500">등록된 사용자가 없습니다.</p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-gray-200 bg-white">
          <table className="min-w-full divide-y divide-gray-200 text-sm">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-6 py-3 text-left font-medium text-gray-500">이름</th>
                <th className="px-6 py-3 text-left font-medium text-gray-500">이메일</th>
                <th className="px-6 py-3 text-left font-medium text-gray-500">역할</th>
                <th className="px-6 py-3 text-center font-medium text-gray-500">배정 현장</th>
                <th className="px-6 py-3 text-center font-medium text-gray-500">상태</th>
                <th className="px-6 py-3 text-center font-medium text-gray-500">관리</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {users.map((user) => {
                const assignmentCount = (user.user_site_assignments as unknown as { count: number }[])?.[0]?.count ?? 0
                return (
                  <tr key={user.id} className="hover:bg-gray-50">
                    <td className="px-6 py-4 font-medium text-gray-900">{user.full_name}</td>
                    <td className="px-6 py-4 text-gray-600">{user.email}</td>
                    <td className="px-6 py-4 text-gray-600">
                      {ROLE_LABELS[user.role as keyof typeof ROLE_LABELS]}
                    </td>
                    <td className="px-6 py-4 text-center text-gray-600">{assignmentCount}개</td>
                    <td className="px-6 py-4 text-center">
                      <Badge variant={user.is_active ? 'green' : 'gray'}>
                        {user.is_active ? '활성' : '비활성'}
                      </Badge>
                    </td>
                    <td className="px-6 py-4 text-center">
                      <Link href={`/admin/users/${user.id}`}>
                        <Button variant="ghost" size="sm">현장 배정</Button>
                      </Link>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
