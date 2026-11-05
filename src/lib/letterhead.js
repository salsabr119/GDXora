// Company letterhead (الورق الرسمي): a blank A4 page the company uploads as a
// PDF or an image. It is turned into one A4 JPEG in the browser, stored in
// org_letterhead, and drawn behind every page of the printable documents.
import { useEffect, useState } from "react";
import { supabase, run, getOrg } from "../supabase.js";

export const A4_PX = { w: 794, h: 1123 };          // document width/height at 96 dpi
const OUT = { w: 1240, h: 1754 };                    // stored image: A4 at 150 dpi
export const MM = A4_PX.w / 210;                     // screen pixels per millimetre

/** PDF (first page) or image → A4 JPEG data URL */
export async function fileToLetterhead(file) {
  const canvas = document.createElement("canvas");
  canvas.width = OUT.w; canvas.height = OUT.h;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, OUT.w, OUT.h);
  if (file.type === "application/pdf" || /\.pdf$/i.test(file.name)) {
    const pdfjs = await import("pdfjs-dist");
    pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();
    const doc = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
    const page = await doc.getPage(1);
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: OUT.w / base.width });
    const tmp = document.createElement("canvas");
    tmp.width = Math.round(viewport.width); tmp.height = Math.round(viewport.height);
    await page.render({ canvasContext: tmp.getContext("2d"), viewport }).promise;
    ctx.drawImage(tmp, 0, 0, OUT.w, Math.min(OUT.h, tmp.height * (OUT.w / tmp.width)));
    await doc.destroy();
  } else {
    const img = await new Promise((ok, bad) => {
      const i = new Image();
      i.onload = () => ok(i); i.onerror = () => bad(new Error("unsupported image"));
      i.src = URL.createObjectURL(file);
    });
    // fit the width; an image taller than A4 is cut at the bottom
    ctx.drawImage(img, 0, 0, OUT.w, img.height * (OUT.w / img.width));
    URL.revokeObjectURL(img.src);
  }
  return canvas.toDataURL("image/jpeg", 0.85);
}

const cache = new Map();   // org id → letterhead row | null
export function forgetLetterhead() { cache.delete(getOrg()); }

/** the current company's letterhead (null when none), loaded once per session */
export function useLetterhead() {
  const org = getOrg();
  const [lh, setLh] = useState(() => (cache.has(org) ? cache.get(org) : undefined));
  useEffect(() => {
    if (cache.has(org)) { setLh(cache.get(org)); return; }
    let live = true;
    run(supabase.from("org_letterhead").select("*").maybeSingle())
      .then((row) => { cache.set(org, row || null); if (live) setLh(row || null); })
      .catch(() => { if (live) setLh(null); });
    return () => { live = false; };
  }, [org]);
  return lh;
}

/** style for an .a4 page drawn on the letterhead: background on every page, content inside the margins */
export function letterheadStyle(lh) {
  if (!lh) return undefined;
  const top = Number(lh.top_mm) * MM, bottom = Number(lh.bottom_mm) * MM, side = Number(lh.side_mm) * MM;
  return {
    backgroundImage: `url(${lh.image_data})`, backgroundSize: `${A4_PX.w}px ${A4_PX.h}px`, backgroundRepeat: "repeat-y",
    padding: `${top}px ${side}px ${bottom}px`,
  };
}
