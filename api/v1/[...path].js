// Vercel catch-all → /api/v1/*
import { send } from "../_lib.js";
import { route } from "./_router.js";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") { res.statusCode = 204; return res.end(); }
  const path = new URL(req.url, "http://x").pathname.replace(/^\/api\/v1\/?/, "");
  const segments = path.split("/").filter(Boolean).map(decodeURIComponent);
  try {
    await route(req, res, segments);
  } catch (e) {
    const status = e.status || 500;
    if (status >= 500) console.error(e);
    send(res, status, { error: status >= 500 ? "internal error" : e.message });
  }
}
