-- ============================================================
-- 011: 현장직원도 소속 현장의 항목별 계상금액을 입력할 수 있게 허용
--
-- 계상금액은 계약 내역서에서 나오는 값이지만, 실무에서는 현장 담당자가
-- 내역서를 보고 직접 기재해야 사용액·잔액 추적이 시작된다.
-- 쓰기는 RPC로만 허용해 총액(sites.direct_expense_budget) 동기화를 보장한다.
-- ============================================================

CREATE OR REPLACE FUNCTION public.upsert_site_expense_budgets(p_site_id UUID, p_items JSONB)
RETURNS void AS $$
DECLARE
  v_sum BIGINT;
BEGIN
  IF NOT (is_site_member(p_site_id) OR get_user_role() IN ('hq_officer', 'system_admin')) THEN
    RAISE EXCEPTION '이 현장의 계상금액을 수정할 권한이 없습니다';
  END IF;

  INSERT INTO public.site_expense_budgets (site_id, category, amount)
  SELECT p_site_id, i->>'category', GREATEST(COALESCE((i->>'amount')::bigint, 0), 0)
  FROM jsonb_array_elements(p_items) AS i
  WHERE i->>'category' IN ('site_residence', 'vehicle', 'business_trip', 'local_staff', 'printing')
  ON CONFLICT (site_id, category) DO UPDATE SET amount = EXCLUDED.amount;

  -- 항목 합계가 있으면 계상총액을 합계로 동기화 (전부 0이면 기존 총액 유지)
  SELECT COALESCE(SUM(amount), 0) INTO v_sum
  FROM public.site_expense_budgets WHERE site_id = p_site_id;
  IF v_sum > 0 THEN
    UPDATE public.sites SET direct_expense_budget = v_sum WHERE id = p_site_id;
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

ALTER FUNCTION public.upsert_site_expense_budgets(uuid, jsonb) SET search_path = public, extensions;
