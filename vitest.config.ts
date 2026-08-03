import path from 'node:path'
import { defineConfig } from 'vitest/config'

// tsconfig의 "@/* → ./src/*" 별칭을 vitest에서도 동일하게 해석
export default defineConfig({
  resolve: {
    alias: { '@': path.resolve(__dirname, 'src') },
  },
})
