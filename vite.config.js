import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { alphaTab } from '@coderline/alphatab-vite'

export default defineConfig({
  plugins: [react(), tailwindcss(), alphaTab()],
  base: './',
})
