'use server'

// 본사 담당자 개별 승인·반려 (F-17/F-18)
//
// 승인: submitted → approved (settlement_round_id는 회차 확정 시 채워진다)
// 반려: submitted → rejected + 사유 필수. 현장은 사유 확인 후 삭제·재입력한다.
// 반려된 건은 회차 확정 편입 대상에서 제외된다 (confirm RPC v3).

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'

async function requireReviewer() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: '로그인이 필요합니다.' as const }

  const { data: profile } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .single()

  if (profile?.role !== 'hq_officer' && profile?.role !== 'system_admin') {
    return { error: '승인·반려 권한이 없습니다.' as const }
  }
  return { userId: user.id }
}

function revalidateReviewPaths() {
  revalidatePath('/hq/review')
  revalidatePath('/hq/overview')
}

export async function approveExpenses(ids: string[]) {
  const auth = await requireReviewer()
  if ('error' in auth) return { error: auth.error }
  if (ids.length === 0) return { error: '승인할 항목이 없습니다.' }

  const admin = createAdminClient()
  const { data, error } = await admin
    .from('expenses')
    .update({ status: 'approved', rejection_reason: null, reviewed_by: auth.userId, reviewed_at: new Date().toISOString() })
    .in('id', ids)
    .eq('status', 'submitted')
    .is('settlement_round_id', null)
    .is('deleted_at', null)
    .select('id')

  if (error) return { error: `승인 실패: ${error.message}` }
  revalidateReviewPaths()
  return { success: true, count: data?.length ?? 0 }
}

export async function rejectExpense(id: string, reason: string) {
  const auth = await requireReviewer()
  if ('error' in auth) return { error: auth.error }

  const trimmed = reason.trim()
  if (!trimmed) return { error: '반려 사유를 입력해주세요.' }

  const admin = createAdminClient()
  const { data, error } = await admin
    .from('expenses')
    .update({ status: 'rejected', rejection_reason: trimmed, reviewed_by: auth.userId, reviewed_at: new Date().toISOString() })
    .eq('id', id)
    .eq('status', 'submitted')
    .is('settlement_round_id', null)
    .is('deleted_at', null)
    .select('id')

  if (error) return { error: `반려 실패: ${error.message}` }
  if (!data || data.length === 0) return { error: '반려할 수 없는 항목입니다 (이미 처리됐거나 회차에 편입됨).' }
  revalidateReviewPaths()
  return { success: true }
}
