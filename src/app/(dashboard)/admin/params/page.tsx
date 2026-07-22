import Link from 'next/link'
import { Settings } from 'lucide-react'
import { createClient } from '@/lib/supabase/server'

export default async function ParamsSiteListPage() {
  const supabase = await createClient()
  const { data: sites } = await supabase
    .from('sites')
    .select('id, name, client_name')
    .is('deleted_at', null)
    .order('created_at', { ascending: false })

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold text-gray-900">정산 기준 설정</h2>
        <p className="mt-1 text-sm text-gray-500">
          현장을 선택해 식대·복리후생비 한도 등 정산 기준 파라미터를 설정합니다.
        </p>
      </div>

      {(!sites || sites.length === 0) ? (
        <div className="rounded-lg border border-dashed border-gray-300 bg-white py-16 text-center text-sm text-gray-400">
          등록된 현장이 없습니다.
        </div>
      ) : (
        <div className="divide-y divide-gray-100 overflow-hidden rounded-lg border border-gray-200 bg-white">
          {sites.map((site) => (
            <Link
              key={site.id}
              href={`/admin/sites/${site.id}/params`}
              className="flex items-center justify-between px-6 py-4 hover:bg-gray-50"
            >
              <div>
                <p className="font-medium text-gray-900">{site.name}</p>
                <p className="text-sm text-gray-500">{site.client_name}</p>
              </div>
              <Settings className="h-4 w-4 text-gray-400" />
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}
