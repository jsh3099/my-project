-- 상주 출근일수가 "기성기간 합계"로 전기되면서(회차 시작 월 레코드에 저장)
-- 월 상한(31일) CHECK가 맞지 않게 됐다. 24개월 회차까지 고려해 상한을 999로 완화한다.
-- (기간 대비 상한 검증은 서버 액션 upsertAttendance에서 기성기간 일수로 수행)

ALTER TABLE public.attendance_records
  DROP CONSTRAINT attendance_records_work_days_check;

ALTER TABLE public.attendance_records
  ADD CONSTRAINT attendance_records_work_days_check
  CHECK (work_days >= 0 AND work_days <= 999);
