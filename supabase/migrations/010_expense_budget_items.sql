-- ============================================================
-- 010: 항목별 직접경비 계상금액 + 회차별 청구(기성) 캡 모델
--
-- 실제 차수별 정산서(예: 청주 도매시장 1~5회 기성) 구조 반영:
--  · 직접경비는 계약 시 항목별(주재비/출장비/도서인쇄비 등)로 계상되고,
--    정산서 2번 표는 항목별 [계약금액|전회누계|금회기성|잔액]을 요구한다.
--  · 발주청 지급액 = min(증빙된 사용액, 계상 잔액). 항목별 초과는
--    직접경비 총액 내에서 흡수 가능(국토교통부 고시 제2023-580호 별표2).
--  · 따라서 "사용액(current_round_amount)"과 "청구액(claim_amount)"을
--    구분해 저장하고, 누계·잔액은 청구액 기준으로 관리한다.
-- ============================================================

-- ── 1. 현장별 항목별 계상금액 ────────────────────────────────
CREATE TABLE public.site_expense_budgets (
  id         UUID PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
  site_id    UUID NOT NULL REFERENCES public.sites(id) ON DELETE CASCADE,
  category   TEXT NOT NULL CHECK (category IN ('site_residence', 'vehicle', 'business_trip', 'local_staff', 'printing')),
  amount     BIGINT NOT NULL DEFAULT 0 CHECK (amount >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (site_id, category)
);

CREATE TRIGGER trg_site_expense_budgets_updated_at
  BEFORE UPDATE ON public.site_expense_budgets
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX idx_site_expense_budgets_site ON public.site_expense_budgets(site_id);

ALTER TABLE public.site_expense_budgets ENABLE ROW LEVEL SECURITY;

CREATE POLICY "site_staff: 소속 현장 계상금액 조회"
  ON public.site_expense_budgets FOR SELECT
  USING (is_site_member(site_id));

CREATE POLICY "hq_officer: 계상금액 관리"
  ON public.site_expense_budgets FOR ALL
  USING (get_user_role() IN ('hq_officer', 'system_admin'))
  WITH CHECK (get_user_role() IN ('hq_officer', 'system_admin'));

-- ── 2. 회차: 금회 계상액(선택 입력)과 청구액 ────────────────────
-- budgeted_amount: 해당 회차 산출내역서상 직접경비 계상액(주재비=상주인건비×10% 등).
--                  수동 입력(선택). 사용액과의 비교 경고에 쓰인다.
-- claim_amount   : 금회 기성 청구액 = min(사용액, 계상총액 잔액). 확정 시 계산.
ALTER TABLE public.settlement_rounds
  ADD COLUMN IF NOT EXISTS budgeted_amount BIGINT CHECK (budgeted_amount IS NULL OR budgeted_amount >= 0),
  ADD COLUMN IF NOT EXISTS claim_amount BIGINT NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.settlement_rounds.prior_cumulative_amount IS '전회까지 누계 청구(기성)액 스냅샷';
COMMENT ON COLUMN public.settlement_rounds.current_round_amount IS '금회 사용액(인정금액 기준) 스냅샷';
COMMENT ON COLUMN public.settlement_rounds.claim_amount IS '금회 청구(기성)액 = min(사용액, 계상총액 잔액)';

-- ── 3. 회차×항목 스냅샷 (정산서 2번 표의 원천) ──────────────────
CREATE TABLE public.settlement_round_items (
  id               UUID PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
  round_id         UUID NOT NULL REFERENCES public.settlement_rounds(id) ON DELETE CASCADE,
  category         TEXT NOT NULL,
  contract_amount  BIGINT NOT NULL DEFAULT 0,  -- 확정 시점 항목별 계상금액
  prior_cumulative BIGINT NOT NULL DEFAULT 0,  -- 항목별 전회 누계 청구액
  used_amount      BIGINT NOT NULL DEFAULT 0,  -- 금회 사용액(인정금액)
  claim_amount     BIGINT NOT NULL DEFAULT 0,  -- 금회 청구액(캡 배분 반영)
  UNIQUE (round_id, category)
);

CREATE INDEX idx_settlement_round_items_round ON public.settlement_round_items(round_id);

ALTER TABLE public.settlement_round_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY "site_staff: 소속 현장 회차 항목 조회"
  ON public.settlement_round_items FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM public.settlement_rounds r
    WHERE r.id = round_id AND is_site_member(r.site_id)
  ));

CREATE POLICY "hq_officer: 회차 항목 관리"
  ON public.settlement_round_items FOR ALL
  USING (get_user_role() IN ('hq_officer', 'system_admin'))
  WITH CHECK (get_user_role() IN ('hq_officer', 'system_admin'));

-- ── 4. 기존 확정 회차 백필 (청구액=사용액으로 간주) ───────────────
UPDATE public.settlement_rounds
SET claim_amount = current_round_amount
WHERE status = 'confirmed' AND claim_amount = 0;

INSERT INTO public.settlement_round_items (round_id, category, contract_amount, prior_cumulative, used_amount, claim_amount)
SELECT
  r.id,
  e.category,
  0,
  COALESCE(SUM(SUM(e.amount - e.over_limit_amount)) OVER (
    PARTITION BY r.site_id, e.category ORDER BY r.round_no
    ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
  ), 0),
  SUM(e.amount - e.over_limit_amount),
  SUM(e.amount - e.over_limit_amount)
FROM public.settlement_rounds r
JOIN public.expenses e ON e.settlement_round_id = r.id AND e.deleted_at IS NULL
WHERE r.status = 'confirmed'
GROUP BY r.id, r.site_id, r.round_no, e.category
ON CONFLICT (round_id, category) DO NOTHING;

-- ── 5. confirm_settlement_round v2: 청구 캡 + 항목별 스냅샷 ───────
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

  -- 금회 사용액 (인정금액 기준)
  SELECT COALESCE(SUM(amount - over_limit_amount), 0) INTO v_used
  FROM public.expenses
  WHERE site_id = v_round.site_id
    AND expense_date BETWEEN v_round.period_start AND v_round.period_end
    AND status = 'submitted'
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
    AND status = 'submitted'
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
