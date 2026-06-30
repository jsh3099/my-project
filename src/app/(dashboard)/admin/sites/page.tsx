import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { deleteSite } from '@/actions/sites'
import { SITE_STATUS_LABELS } from '@/lib/constants'
import { Building2, Plus, Settings } from 'lucide-react'

export default async function SitesPage() {
  const supabase = await createClient()
  const { data: sites } = await supabase
    .from('sites')
    .select('*')
    .is('deleted_at', null)
    .order('created_at', { ascending: false })

  const statusVariant = {
    active: 'green' as const,
    completed: 'gray' as const,
    suspended: 'red' as const,
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold text-gray-900">현장 관리</h2>
          <p className="mt-1 text-sm text-gray-500">등록된 현장 목록을 관리합니다.</p>
        </div>
        <Link href="/admin/sites/new">
          <Button>
            <Plus className="h-4 w-4" />
            현장 등록
          </Button>
        </Link>
      </div>

      {(!sites || sites.length === 0) ? (
        <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-gray-300 bg-white py-16 text-center">
          <Building2 className="h-12 w-12 text-gray-300" />
          <p className="mt-3 text-sm text-gray-500">등록된 현장이 없습니다.</p>
          <Link href="/admin/sites/new" className="mt-4">
            <Button variant="secondary" size="sm">첫 번째 현장 등록하기</Button>
          </Link>
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-gray-200 bg-white">
          <table className="min-w-full divide-y divide-gray-200 text-sm">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-6 py-3 text-left font-medium text-gray-500">현장명</th>
                <th className="px-6 py-3 text-left font-medium text-gray-500">발주처</th>
                <th className="px-6 py-3 text-left font-medium text-gray-500">계약기간</th>
                <th className="px-6 py-3 text-right font-medium text-gray-500">직접경비 예산</th>
                <th className="px-6 py-3 text-center font-medium text-gray-500">상태</th>
                <th className="px-6 py-3 text-center font-medium text-gray-500">관리</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {sites.map((site) => (
                <tr key={site.id} className="hover:bg-gray-50">
                  <td className="px-6 py-4 font-medium text-gray-900">{site.name}</td>
                  <td className="px-6 py-4 text-gray-600">{site.client_name}</td>
                  <td className="px-6 py-4 text-gray-600">
                    {site.contract_start} ~ {site.contract_end}
                  </td>
                  <td className="px-6 py-4 text-right text-gray-600">
                    {site.direct_expense_budget.toLocaleString()}원
                  </td>
                  <td className="px-6 py-4 text-center">
                    <Badge variant={statusVariant[site.status as keyof typeof statusVariant]}>
                      {SITE_STATUS_LABELS[site.status as keyof typeof SITE_STATUS_LABELS]}
                    </Badge>
                  </td>
                  <td className="px-6 py-4">
                    <div className="flex items-center justify-center gap-2">
                      <Link href={`/admin/sites/${site.id}`}>
                        <Button variant="ghost" size="sm">수정</Button>
                      </Link>
                      <Link href={`/admin/sites/${site.id}/params`}>
                        <Button variant="ghost" size="sm">
                          <Settings className="h-4 w-4" />
                          파라미터
                        </Button>
                      </Link>
                      <form action={async () => { await deleteSite(site.id) }}>
                        <Button variant="ghost" size="sm" className="text-red-600 hover:bg-red-50">
                          삭제
                        </Button>
                      </form>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
