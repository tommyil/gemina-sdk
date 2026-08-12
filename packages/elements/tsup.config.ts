import { defineConfig } from 'tsup';

export default defineConfig({
  // Four public entry points = four subpath exports:
  //   "."               -> src/index.ts   (everything)
  //   "./token-manager" -> src/token-manager.ts (zero deps, no React)
  //   "./chat"          -> src/chat.tsx   (React component)
  //   "./verification"  -> src/verification/index.tsx (React component)
  entry: {
    index: 'src/index.ts',
    'token-manager': 'src/token-manager.ts',
    chat: 'src/chat.tsx',
    verification: 'src/verification/index.tsx',
  },
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'es2020',
  external: ['react', 'react-dom', '@gemina/sdk'],
});
