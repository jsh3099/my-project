import { StaffCostsPageContent } from '../_shared'

export default function StaffCostsSupportPage({
  searchParams,
}: {
  searchParams: Promise<{ ym?: string; site?: string }>
}) {
  return <StaffCostsPageContent staffType="support" searchParams={searchParams} />
}
