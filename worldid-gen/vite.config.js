import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
    plugins: [react()],
    server: { port: 4567 },
    optimizeDeps: {
        // Exclude idkit-core from pre-bundling so the WASM file
        // stays resolvable via import.meta.url
        exclude: ['@worldcoin/idkit-core'],
    },
})
