import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // The gateway's pure logic. Anything that needs a real ffmpeg or a real
    // window is covered by the end-to-end suites instead.
    include: ['electron/**/*.test.ts', 'src/**/*.test.ts', 'shared/**/*.test.ts'],
    exclude: ['node_modules', 'out', 'release', 'resources', 'fixtures'],
  },
})
