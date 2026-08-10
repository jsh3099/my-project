-- 현장직원도 소속 현장의 기성회차를 시작할 수 있게 한다.
-- 실무: 기성 기간의 증빙(영수증·출근부)을 첨부하는 주체가 현장이므로,
-- 회차(기간) 생성을 본사에만 묶어두면 현장 입력이 막힌다.
-- 확정(confirm_settlement_round)은 기존대로 본사 담당자·관리자 전용.

CREATE POLICY "site_staff: 소속 현장 회차 생성"
  ON public.settlement_rounds FOR INSERT
  WITH CHECK (is_site_member(site_id));
