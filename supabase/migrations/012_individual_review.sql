-- 012: 개별 승인·반려 워크플로 (F-17/F-18)
--
-- 본사 담당자가 제출(submitted) 건을 개별 승인(approved)·반려(rejected)할 수 있게 되면서,
-- 회차 확정 시점에는 아직 검토되지 않은 submitted 건과 개별 승인된 approved(미편입) 건을
-- 모두 편입해야 한다. 반려(rejected) 건은 편입 대상에서 제외된다.

-- ── 1. 검토 감사 컬럼 ────────────────────────────────────────────
ALTER TABLE public.expenses
  ADD COLUMN IF NOT EXISTS reviewed_by UUID REFERENCES public.profiles(id),
  ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ;

-- ── 2. confirm_settlement_round v3: submitted + approved(미편입) 편입 ──
CREATE OR REPLACE FUNCTION public.confirm_settlement_round(p_round_id UUID)
RETURNS public.settlement_rounds AS $$
DECLARE
  v_round        public.settlement_rounds;
  v_total_budget BIGINT;
  v_prior_claim  BIGINT;
  v_used         BIGINT;
  v_remaining    BIGINT;
  v_claim        BIGINT;
  v_delta        BIGINT;
BEGIN
  IF get_user_role() NOT IN ('hq_officer', 'system_admin') THEN
    RAISE EXCEPTION '정산 확정 권한이 없습니다';
  END IF;

  SELECT * INTO v_round FROM public.settlement_rounds WHERE id = p_round_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION '회차를 찾을 수 없습니다';
  END IF;
  IF v_round.status = 'confirmed' THEN
    RAISE EXCEPTION '이미 확정된 회차입니다';
  END IF;

  SELECT direct_expense_budget INTO v_total_budget FROM public.sites WHERE id = v_round.site_id;

  -- 전회 누계 청구액 (청구 기준 잔액 산출용)
  SELECT COALESCE(SUM(claim_amount), 0) INTO v_prior_claim
  FROM public.settlement_rounds
  WHERE site_id = v_round.site_id AND round_no < v_round.round_no AND status = 'confirmed';

  -- 금회 사용액 (인정금액 기준) — 미검토 제출건 + 개별 승인건
  SELECT COALESCE(SUM(amount - over_limit_amount), 0) INTO v_used
  FROM public.expenses
  WHERE site_id = v_round.site_id
    AND expense_date BETWEEN v_round.period_start AND v_round.period_end
    AND status IN ('submitted', 'approved')
    AND settlement_round_id IS NULL
    AND deleted_at IS NULL;

  -- 청구액 = min(사용액, 계상총액 잔액) — 최종회차에서 잔액을 초과한 사용분은 미지급
  v_remaining := GREATEST(v_total_budget - v_prior_claim, 0);
  v_claim := LEAST(v_used, v_remaining);

  -- 대상 지출 편입 (확정 잠금)
  UPDATE public.expenses
  SET settlement_round_id = v_round.id, status = 'approved'
  WHERE site_id = v_round.site_id
    AND expense_date BETWEEN v_round.period_start AND v_round.period_end
    AND status IN ('submitted', 'approved')
    AND settlement_round_id IS NULL
    AND deleted_at IS NULL;

  -- 항목별 스냅샷: 계상금액·전회누계·사용액·청구액(사용액 비례 배분)
  INSERT INTO public.settlement_round_items (round_id, category, contract_amount, prior_cumulative, used_amount, claim_amount)
  SELECT
    v_round.id,
    c.category,
    COALESCE(b.amount, 0),
    COALESCE(p.prior, 0),
    COALESCE(u.used, 0),
    CASE WHEN v_used > 0
      THEN ROUND(COALESCE(u.used, 0)::numeric * v_claim / v_used)::bigint
      ELSE 0
    END
  FROM (
    SELECT unnest(ARRAY['site_residence', 'vehicle', 'business_trip', 'local_staff', 'printing']) AS category
  ) c
  LEFT JOIN public.site_expense_budgets b
    ON b.site_id = v_round.site_id AND b.category = c.category
  LEFT JOIN (
    SELECT i.category, SUM(i.claim_amount) AS prior
    FROM public.settlement_round_items i
    JOIN public.settlement_rounds r ON r.id = i.round_id
    WHERE r.site_id = v_round.site_id AND r.round_no < v_round.round_no AND r.status = 'confirmed'
    GROUP BY i.category
  ) p ON p.category = c.category
  LEFT JOIN (
    SELECT category, SUM(amount - over_limit_amount) AS used
    FROM public.expenses
    WHERE settlement_round_id = v_round.id AND deleted_at IS NULL
    GROUP BY category
  ) u ON u.category = c.category;

  -- 비례 배분 반올림 오차를 사용액이 가장 큰 항목에 보정
  SELECT v_claim - COALESCE(SUM(claim_amount), 0) INTO v_delta
  FROM public.settlement_round_items WHERE round_id = v_round.id;
  IF v_delta <> 0 THEN
    UPDATE public.settlement_round_items
    SET claim_amount = claim_amount + v_delta
    WHERE id = (
      SELECT id FROM public.settlement_round_items
      WHERE round_id = v_round.id ORDER BY used_amount DESC, category LIMIT 1
    );
  END IF;

  UPDATE public.settlement_rounds
  SET status = 'confirmed',
      current_round_amount = v_used,
      prior_cumulative_amount = v_prior_claim,
      claim_amount = v_claim,
      confirmed_by = auth.uid(),
      confirmed_at = NOW()
  WHERE id = p_round_id
  RETURNING * INTO v_round;

  RETURN v_round;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

ALTER FUNCTION public.confirm_settlement_round(uuid) SET search_path = public, extensions;
