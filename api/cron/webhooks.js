// Webhook dispatcher — run by Vercel Cron (see vercel.json). Delivers pending
// events with an HMAC signature and exponential backoff (handled in SQL).
import crypto from "node:crypto";
import { serviceClient, send } from "../_lib.js";

export function sign(secret, timestamp, body) {
  return crypto.createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
}

export default async function handler(req, res) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.authorization !== `Bearer ${secret}`) return send(res, 401, { error: "unauthorized" });
  const db = serviceClient();
  const { data: batch, error } = await db.rpc("claim_webhook_deliveries", { p_limit: 50 });
  if (error) return send(res, 500, { error: error.message });

  const results = await Promise.allSettled((batch || []).map(async (d) => {
    const body = JSON.stringify(d.payload);
    const ts = Math.floor(Date.now() / 1000);
    let ok = false, status = null, err = null;
    try {
      const r = await fetch(d.url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "User-Agent": "GDXora-Webhooks/1",
                   "X-GDXora-Event": d.event_type, "X-GDXora-Delivery": String(d.delivery_id),
                   "X-GDXora-Signature": `t=${ts},v1=${sign(d.secret, ts, body)}` },
        body, signal: AbortSignal.timeout(10000),
      });
      status = r.status; ok = r.ok;
      if (!ok) err = `HTTP ${r.status}`;
    } catch (e) { err = e.message; }
    await db.rpc("mark_webhook_delivery", { p_id: d.delivery_id, p_ok: ok, p_status: status, p_error: err });
    return ok;
  }));
  send(res, 200, { processed: results.length, delivered: results.filter((r) => r.status === "fulfilled" && r.value).length });
}
