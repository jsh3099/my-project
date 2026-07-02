import Link from 'next/link'
import { notFound } from 'next/navigation'
import { ChevronLeft, UserCheck, UserX } from 'lucide-react'
import { createClient } from '@/lib/supabase/server'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { ROLE_LABELS, SITE_STATUS_LABELS } from '@/lib/constants'
import { assignSite, unassignSite } from '@/actions/users'

interface Props {
  params: Promise<{ userId: string }>
}

export default async function UserDetailPage({ params }: Props) {
  const { userId } = await params
  const supabase = await createClient()

  const [{ data: user }, { data: allSites }, { data: assignments }] = await Promise.all([
    supabase.from('profiles').select('*').eq('id', userId).is('deleted_at', null).single(),
    supabase.from('sites').select('id, name, client_name, status').is('deleted_at', null).order('name'),
    supabase.from('user_site_assignments').select('site_id, is_active').eq('user_id', userId),
  ])

  if (!user) notFound()

  const assignedSiteIds = new Set(
    (assignments ?? []).filter((a) => a.is_active).map((a) => a.site_id)
  )
  const assignedSites = (allSites ?? []).filter((s) => assignedSiteIds.has(s.id))
  const unassignedSites = (allSites ?? []).filter((s) => !assignedSiteIds.has(s.id))

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <Link
          href="/admin/users"
          className="flex items-center gap-1 text-sm text-gray-500 hover:text-gray-900"
        >
          <ChevronLeft className="h-4 w-4" />
          사용자 목록으로
        </Link>
        <h2 className="mt-3 text-xl font-semibold text-gray-900">
          현장 배정 — {user.full_name}
        </h2>
        <p className="mt-1 text-sm text-gray-500">
          {user.email} · {ROLE_LABELS[user.role as keyof typeof ROLE_LABELS]}
        </p>
      </div>

      <div className="rounded-lg border border-gray-200 bg-white p-6 space-y-4">
        <h3 className="text-sm font-semibold text-gray-700">배정된 현장 ({assignedSites.length})</h3>
        {assignedSites.length === 0 ? (
          <p className="text-sm text-gray-400">배정된 현장이 없습니다.</p>
        ) : (
          <ul className="divide-y divide-gray-100">
            {assignedSites.map((site) => (
              <li key={site.id} className="flex items-center justify-between py-3">
                <div>
                  <p className="text-sm font-medium text-gray-800">{site.name}</p>
                  <p className="text-xs text-gray-500">{site.client_name}</p>
                </div>
                <div className="flex items-center gap-3">
                  <Badge variant={site.status === 'active' ? 'green' : 'gray'}>
                    {SITE_STATUS_LABELS[site.status as keyof typeof SITE_STATUS_LABELS]}
                  </Badge>
                  <form action={unassignSite.bind(null, userId, site.id) as never}>
                    <Button variant="ghost" size="sm" className="text-red-600 hover:bg-red-50">
                      <UserX className="h-4 w-4" />
                      배정 해제
                    </Button>
                  </form>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {unassignedSites.length > 0 && (
        <div className="rounded-lg border border-gray-200 bg-white p-6 space-y-4">
          <h3 className="text-sm font-semibold text-gray-700">미배정 현장</h3>
          <ul className="divide-y divide-gray-100">
            {unassignedSites.map((site) => (
              <li key={site.id} className="flex items-center justify-between py-3">
                <div>
                  <p className="text-sm font-medium text-gray-800">{site.name}</p>
                  <p className="text-xs text-gray-500">{site.client_name}</p>
                </div>
                <form action={assignSite.bind(null, userId, site.id) as never}>
                  <Button variant="secondary" size="sm">
                    <UserCheck className="h-4 w-4" />
                    배정
                  </Button>
                </form>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
