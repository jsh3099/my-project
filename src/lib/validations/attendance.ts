import { z } from 'zod'

export const attendanceSchema = z.object({
  site_id: z.string().min(1, '현장을 선택하세요'),
  user_id: z.string().min(1, '직원을 선택하세요'),
  year: z.coerce.number().int().min(2020).max(2100),
  month: z.coerce.number().int().min(1).max(12),
  work_days: z.coerce.number().int('정수를 입력하세요').min(0).max(31, '31일을 초과할 수 없습니다'),
})

export type AttendanceFormValues = z.infer<typeof attendanceSchema>
