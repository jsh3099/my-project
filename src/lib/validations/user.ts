import { z } from 'zod'

export const userSchema = z.object({
  full_name: z.string().min(1, '이름을 입력하세요'),
  email: z.string().email('올바른 이메일 주소를 입력하세요'),
  password: z.string().min(8, '비밀번호는 8자 이상이어야 합니다'),
  role: z.enum(['site_staff', 'hq_officer', 'system_admin']),
})

export type UserFormValues = z.infer<typeof userSchema>
