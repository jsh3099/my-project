-- ============================================================
-- expenses.target_user_id: 인원별 항목(임대비·관리비·식대·교통비·출장비·
-- 현지사무원 급여)의 실제 대상자를 profiles와 안전하게 연결
--
-- 기존 target_user_name(TEXT)은 미등록 인원(추가 행)을 위해 유지한다.
-- 등록된 직원인 경우 target_user_id를 채우고, 추가 행은 target_user_id를
-- NULL로 둔 채 target_user_name만 사용한다.
-- ============================================================
ALTER TABLE public.expenses
  ADD COLUMN IF NOT EXISTS target_user_id UUID REFERENCES public.profiles(id);

CREATE INDEX IF NOT EXISTS idx_expenses_target_user_id ON public.expenses(target_user_id);

-- 기존 데이터 백필: 같은 현장에 배정된 직원 중 이름이 정확히 일치하는 경우만 연결
UPDATE public.expenses e
SET target_user_id = p.id
FROM public.profiles p
JOIN public.user_site_assignments usa ON usa.user_id = p.id AND usa.site_id = e.site_id
WHERE e.target_user_id IS NULL
  AND e.target_user_name IS NOT NULL
  AND p.full_name = e.target_user_name;
