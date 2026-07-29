import Link from 'next/link'
import { notFound } from 'next/navigation'
import { ChevronLeft } from 'lucide-react'
import { createClient } from '@/lib/supabase/server'
import { SiteForm } from '@/components/sites/SiteForm'
import { updateSite } from '@/actions/sites'

interface Props {
  params: Promise<{ siteId: string }>
}

export default async function SiteDetailPage({ params }: Props) {
  const { siteId } = await params
  const supabase = await createClient()

  const [{ data: site }, { data: budgetRows }] = await Promise.all([
    supabase
      .from('sites')
      .select('*')
      .eq('id', siteId)
      .is('deleted_at', null)
      .single(),
    supabase
      .from('site_expense_budgets')
      .select('category, amount')
      .eq('site_id', siteId),
  ])

  if (!site) notFound()

  const budgets = Object.fromEntries(
    (budgetRows ?? []).map((b) => [b.category, b.amount]),
  )

  const action = updateSite.bind(null, siteId)

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
        <h2 className="mt-3 text-xl font-semibold text-gray-900">현장 수정 — {site.name}</h2>
      </div>

      <div className="rounded-lg border border-gray-200 bg-white p-6">
        <SiteForm site={site} budgets={budgets} action={action} />
      </div>
    </div>
  )
}
