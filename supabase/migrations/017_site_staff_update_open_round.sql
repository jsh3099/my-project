-- 현장직원이 소속 현장의 "진행 중" 회차 기간을 수정할 수 있게 한다.
-- 확정(confirmed) 회차는 청구액·누계가 스냅샷으로 굳은 정산 이력이므로 수정 불가 —
-- USING/WITH CHECK 모두 status='open'을 요구해 확정 회차로의 변경·확정 상태 해제도 막는다.

CREATE POLICY "site_staff: 소속 현장 진행 중 회차 수정"
  ON public.settlement_rounds FOR UPDATE
  USING (is_site_member(site_id) AND status = 'open')
  WITH CHECK (is_site_member(site_id) AND status = 'open');
