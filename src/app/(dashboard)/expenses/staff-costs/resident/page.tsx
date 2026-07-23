import { StaffCostsPageContent } from '../_shared'

export default function StaffCostsResidentPage({
  searchParams,
}: {
  searchParams: Promise<{ ym?: string; site?: string }>
}) {
  return <StaffCostsPageContent staffType="resident" searchParams={searchParams} />
}
