import { defineConfig } from 'tsup';

export default defineConfig({
  // Three public entry points = three subpath exports:
  //   "."               -> src/index.ts   (everything)
  //   "./token-manager" -> src/token-manager.ts (zero deps, no React)
  //   "./chat"          -> src/chat.tsx   (React component)
  entry: {
    index: 'src/index.ts',
    'token-manager': 'src/token-manager.ts',
    chat: 'src/chat.tsx',
  },
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'es2020',
  external: ['react', 'react-dom', '@gemina/sdk'],
});
