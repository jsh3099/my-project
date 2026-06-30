import Link from 'next/link'
import { ChevronLeft } from 'lucide-react'
import { UserForm } from '@/components/users/UserForm'
import { createUser } from '@/actions/users'

export default function NewUserPage() {
  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <Link
          href="/admin/users"
          className="flex items-center gap-1 text-sm text-gray-500 hover:text-gray-900"
        >
          <ChevronLeft className="h-4 w-4" />
          사용자 목록으로
        </Link>
        <h2 className="mt-3 text-xl font-semibold text-gray-900">사용자 등록</h2>
      </div>

      <div className="rounded-lg border border-gray-200 bg-white p-6">
        <UserForm action={createUser} />
      </div>
    </div>
  )
}
