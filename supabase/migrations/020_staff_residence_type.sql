-- 상주기술인 거주 형태 — 예본 5회차 「1-1 상주기술인 숙소비 사용내역」에는 상주 13명 중
-- 8명만 올라온다(강희철·이병필·신우상·정상윤·지창호는 자가출퇴근). 이 구분이
--   ① 숙소임대비·관리비 계상 여부
--   ② 교통비 승수 (숙박형=월 귀가 횟수 / 출퇴근형=근무일수)
--   ③ 요구 증빙 (숙소계약서·이체확인증·관리비 사용내역)
--   ④ 정산서 1-1 표 포함 여부
-- 를 모두 가르는데, 지금까지는 회차마다 교통비 칸에서 다시 지정해야 했다.
--
-- 거주 형태는 사람의 속성이므로 명부(정산 인원의 단일 원천)에 둔다.
-- 회차 중 이사한 경우는 주재비 폼에서 그 회차만 덮어쓴다(commuteMode가 실효값).
-- 기술지원 기술인은 숙소를 쓰지 않으므로(출장비로 정산) 이 값을 쓰지 않는다.

ALTER TABLE public.site_staff_members
  ADD COLUMN IF NOT EXISTS residence_type TEXT NOT NULL DEFAULT 'lodging'
  CHECK (residence_type IN ('lodging', 'commute'));

COMMENT ON COLUMN public.site_staff_members.residence_type IS
  'lodging=숙소 사용, commute=자가 출퇴근(숙소비 없음). 주재비 폼 거주 형태 기본값';
