import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // VITE_* locally; NEXT_PUBLIC_* are injected by the Supabase ↔ Vercel integration
  envPrefix: ["VITE_", "NEXT_PUBLIC_"],
  test: { include: ["tests/**/*.test.js"] },
});
