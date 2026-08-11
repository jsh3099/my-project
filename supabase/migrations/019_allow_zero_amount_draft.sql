-- 영수증을 올리는 즉시 저장하는 흐름(주재비 폼)에서, 금액이 확정되기 전에
-- 첨부만 담아둘 draft 행이 필요하다. 자동 인식 → 사용자 확인 → 금액 저장 순서라
-- 첨부 시점에는 금액이 0일 수밖에 없다.
--
-- amount > 0 불변조건은 제출 이후 단계에서만 의미가 있으므로 draft에만 0을 허용한다.
-- (submitted·approved·rejected는 그대로 양수 강제)

ALTER TABLE public.expenses
  DROP CONSTRAINT expenses_amount_check;

ALTER TABLE public.expenses
  ADD CONSTRAINT expenses_amount_check
  CHECK (amount > 0 OR status = 'draft');
