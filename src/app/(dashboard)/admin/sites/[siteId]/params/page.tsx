import Link from 'next/link'
import { notFound } from 'next/navigation'
import { ChevronLeft } from 'lucide-react'
import { createClient } from '@/lib/supabase/server'
import { SiteParamsForm } from '@/components/sites/SiteParamsForm'
import { upsertSiteParams } from '@/actions/siteParams'

interface Props {
  params: Promise<{ siteId: string }>
}

export default async function SiteParamsPage({ params }: Props) {
  const { siteId } = await params
  const supabase = await createClient()

  const [{ data: site }, { data: siteParams }] = await Promise.all([
    supabase.from('sites').select('name').eq('id', siteId).is('deleted_at', null).single(),
    supabase.from('site_parameters').select('*').eq('site_id', siteId).maybeSingle(),
  ])

  if (!site) notFound()

  const action = upsertSiteParams.bind(null, siteId)

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <Link
          href="/admin/sites"
          className="flex items-center gap-1 text-sm text-gray-500 hover:text-gray-900"
        >
          <ChevronLeft className="h-4 w-4" />
          현장 목록으로
        </Link>
        <h2 className="mt-3 text-xl font-semibold text-gray-900">
          정산 기준 파라미터 — {site.name}
        </h2>
        <p className="mt-1 text-sm text-gray-500">
          현장별 정산 한도 및 규정 적용 기준을 설정합니다.
        </p>
      </div>

      <div className="rounded-lg border border-gray-200 bg-white p-6">
        <SiteParamsForm siteId={siteId} params={siteParams} action={action} />
      </div>
    </div>
  )
}
