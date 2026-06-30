import Link from 'next/link'
import { ChevronLeft } from 'lucide-react'
import { SiteForm } from '@/components/sites/SiteForm'
import { createSite } from '@/actions/sites'

export default function NewSitePage() {
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
        <h2 className="mt-3 text-xl font-semibold text-gray-900">현장 등록</h2>
      </div>

      <div className="rounded-lg border border-gray-200 bg-white p-6">
        <SiteForm action={createSite} />
      </div>
    </div>
  )
}
