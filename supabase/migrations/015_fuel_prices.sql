-- 015: 오피넷 일별 평균 유가 캐시
--
-- 예본 각주: "유가 등은 운행일자의 한국석유공사 유가정보서비스(www.opinet.co.kr)에서
-- 고시된 유가를 적용함". 오피넷 무료 API는 최근 7일 중심이므로, 조회한 유가를
-- 날짜별로 적재해 과거 운행일도 재조회 없이 쓴다 (지연 입력 대응 + 호출건수 절약).

CREATE TABLE IF NOT EXISTS public.fuel_prices (
  id           UUID PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
  price_date   DATE NOT NULL,
  product_code TEXT NOT NULL CHECK (product_code IN ('B027', 'D047', 'K015')), -- 휘발유/경유/LPG(부탄)
  price        NUMERIC(10, 2) NOT NULL CHECK (price > 0),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (price_date, product_code)
);

COMMENT ON TABLE public.fuel_prices IS '오피넷 전국 일별 평균 유가 캐시 — 운행일자 기준 유가 자동입력의 원천';

ALTER TABLE public.fuel_prices ENABLE ROW LEVEL SECURITY;

-- 조회는 로그인 사용자 전체, 적재는 서버(service role)만
DROP POLICY IF EXISTS "authenticated: 유가 조회" ON public.fuel_prices;
CREATE POLICY "authenticated: 유가 조회" ON public.fuel_prices
  FOR SELECT TO authenticated
  USING (true);
