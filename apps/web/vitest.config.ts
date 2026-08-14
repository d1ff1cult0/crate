import { defineConfig } from 'vitest/config'

// Only the pure logic in src/lib is tested here — §11: "the UI does not" get tests.
// Route handlers and pages need a database and a Next runtime; the things worth testing
// in this app are the pure functions they call.
export default defineConfig({
  test: { include: ['test/**/*.test.ts'] },
})
