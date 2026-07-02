'use client'

import { Info } from 'lucide-react'
import { REQUIREMENT_GUIDE } from '@/lib/expense-categories'

interface RequirementGuideProps {
  subcategory: string
}

export function RequirementGuide({ subcategory }: RequirementGuideProps) {
  const requirements = REQUIREMENT_GUIDE[subcategory]
  if (!requirements || requirements.length === 0) return null

  return (
    <div className="rounded-md bg-blue-50 border border-blue-200 px-4 py-3">
      <div className="flex items-start gap-2">
        <Info className="h-4 w-4 text-blue-500 mt-0.5 shrink-0" />
        <div>
          <p className="text-sm font-medium text-blue-800 mb-1">필수 증빙 서류</p>
          <ul className="space-y-0.5">
            {requirements.map((req) => (
              <li key={req} className="text-sm text-blue-700">
                {req.startsWith('※') ? (
                  <span className="font-medium text-red-600">{req}</span>
                ) : (
                  `• ${req}`
                )}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  )
}
