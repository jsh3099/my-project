-- ============================================================
-- settlement_rounds: 현장별 기성회차(정산 차수)
--
-- 정산서 2번 표(전회기성/금회기성/잔액)를 만들기 위해, "몇 회차까지 확정됐고
-- 그 시점의 금액이 얼마였는지"를 회차 확정 시점에 스냅샷으로 남긴다.
-- 확정 이후에는 prior_cumulative_amount/current_round_amount가 바뀌지 않아야
-- 하므로(감사 추적), 매번 재계산하지 않고 확정 시 저장한다.
-- ============================================================
CREATE TABLE public.settlement_rounds (
  id                      UUID PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
  site_id                 UUID NOT NULL REFERENCES public.sites(id) ON DELETE CASCADE,
  round_no                INTEGER NOT NULL CHECK (round_no > 0),
  period_start            DATE NOT NULL,
  period_end              DATE NOT NULL,
  status                  TEXT NOT NULL DEFAULT 'open'
                            CHECK (status IN ('open', 'confirmed')),
  prior_cumulative_amount BIGINT NOT NULL DEFAULT 0,
  current_round_amount    BIGINT NOT NULL DEFAULT 0,
  confirmed_by            UUID REFERENCES public.profiles(id),
  confirmed_at            TIMESTAMPTZ,
  created_by              UUID REFERENCES public.profiles(id),
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (site_id, round_no),
  CHECK (period_end >= period_start)
);

CREATE TRIGGER trg_settlement_rounds_updated_at
  BEFORE UPDATE ON public.settlement_rounds
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX idx_settlement_rounds_site ON public.settlement_rounds(site_id);

-- expenses ↔ settlement_rounds: 확정된 회차에 편입된 지출 건에 회차 id가 채워진다.
-- (deleteExpense 등 기존 앱 로직이 status='draft'만 수정·삭제를 허용하고,
--  회차 확정 시 status를 'approved'로 바꾸므로 별도 RLS 변경 없이도 확정 건은 잠긴다.)
ALTER TABLE public.expenses
  ADD COLUMN IF NOT EXISTS settlement_round_id UUID REFERENCES public.settlement_rounds(id);

CREATE INDEX IF NOT EXISTS idx_expenses_settlement_round_id ON public.expenses(settlement_round_id);

-- ============================================================
-- RLS: 현장 소속 인원은 조회만, 본사담당자/관리자만 생성·확정 가능
-- ============================================================
ALTER TABLE public.settlement_rounds ENABLE ROW LEVEL SECURITY;

CREATE POLICY "site_staff: 소속 현장 회차 조회"
  ON public.settlement_rounds FOR SELECT
  USING (is_site_member(site_id));

CREATE POLICY "hq_officer: 회차 관리"
  ON public.settlement_rounds FOR ALL
  USING (get_user_role() IN ('hq_officer', 'system_admin'))
  WITH CHECK (get_user_role() IN ('hq_officer', 'system_admin'));

-- ============================================================
-- confirm_settlement_round: 회차 확정 RPC
--
-- 대상 기간·현장의 'submitted' 지출을 이 회차에 편입(status → approved,
-- settlement_round_id 기록)하고, 직전 확정 회차의 누계를 이어받아
-- prior_cumulative_amount/current_round_amount를 스냅샷 저장한다.
-- 불인정(over_limit_amount)은 금회 사용액 집계에서 제외한다.
-- ============================================================
CREATE OR REPLACE FUNCTION public.confirm_settlement_round(p_round_id UUID)
RETURNS public.settlement_rounds AS $$
DECLARE
  v_round        public.settlement_rounds;
  v_prior_round  public.settlement_rounds;
  v_current_amt  BIGINT;
  v_prior_cum    BIGINT;
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

  SELECT * INTO v_prior_round
    FROM public.settlement_rounds
    WHERE site_id = v_round.site_id AND round_no = v_round.round_no - 1 AND status = 'confirmed';

  v_prior_cum := COALESCE(v_prior_round.prior_cumulative_amount, 0) + COALESCE(v_prior_round.current_round_amount, 0);

  SELECT COALESCE(SUM(amount - over_limit_amount), 0) INTO v_current_amt
  FROM public.expenses
  WHERE site_id = v_round.site_id
    AND expense_date BETWEEN v_round.period_start AND v_round.period_end
    AND status = 'submitted'
    AND settlement_round_id IS NULL
    AND deleted_at IS NULL;

  UPDATE public.expenses
  SET settlement_round_id = v_round.id, status = 'approved'
  WHERE site_id = v_round.site_id
    AND expense_date BETWEEN v_round.period_start AND v_round.period_end
    AND status = 'submitted'
    AND settlement_round_id IS NULL
    AND deleted_at IS NULL;

  UPDATE public.settlement_rounds
  SET status = 'confirmed',
      current_round_amount = v_current_amt,
      prior_cumulative_amount = v_prior_cum,
      confirmed_by = auth.uid(),
      confirmed_at = NOW()
  WHERE id = p_round_id
  RETURNING * INTO v_round;

  RETURN v_round;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

ALTER FUNCTION public.confirm_settlement_round(uuid) SET search_path = public, extensions;
