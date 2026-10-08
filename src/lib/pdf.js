// Render a DOM node (an A4 document) to a PDF Blob.
// The browser itself draws the node (html-to-image → SVG foreignObject), so
// Arabic shaping and RTL are exactly as on screen; jsPDF only paginates the
// bitmap. Libraries are loaded on demand to keep the main bundle small.

const A4 = { w: 210, h: 297 }; // mm

export async function nodeToPdf(node) {
  const [{ toCanvas }, { jsPDF }] = await Promise.all([import("html-to-image"), import("jspdf")]);
  const canvas = await toCanvas(node, { pixelRatio: 2, backgroundColor: "#ffffff", cacheBust: true });
  const pdf = new jsPDF({ unit: "mm", format: "a4", compress: true });
  const pagePx = Math.floor((canvas.width * A4.h) / A4.w);   // canvas pixels per A4 page
  for (let y = 0, first = true; y < canvas.height; y += pagePx, first = false) {
    const h = Math.min(pagePx, canvas.height - y);
    if (!first && h < pagePx * 0.02) break;     // sub-pixel overflow, not a real page
    const slice = document.createElement("canvas");
    slice.width = canvas.width; slice.height = h;
    const ctx = slice.getContext("2d");
    ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, slice.width, h);
    ctx.drawImage(canvas, 0, y, canvas.width, h, 0, 0, canvas.width, h);
    if (!first) pdf.addPage();
    pdf.addImage(slice.toDataURL("image/jpeg", 0.92), "JPEG", 0, 0, A4.w, (h * A4.w) / canvas.width);
  }
  return pdf.output("blob");
}

export function downloadBlob(blob, filename) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

/** Share via the OS share sheet (WhatsApp, Mail…) when files can be shared; otherwise download. */
export async function shareOrDownload(blob, filename, { title, text } = {}) {
  const file = new File([blob], filename, { type: blob.type || "application/pdf" });
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title, text }); return "shared"; }
    catch (e) { if (e?.name === "AbortError") return "cancelled"; }
  }
  downloadBlob(blob, filename);
  return "downloaded";
}

/** Downscale an image file to ≤ max px (longest side) and return a PNG data URL. */
export function imageFileToDataUrl(file, max = 512) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const k = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement("canvas");
      c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(img.src);
      resolve(c.toDataURL("image/png"));
    };
    img.onerror = () => reject(new Error("unsupported image"));
    img.src = URL.createObjectURL(file);
  });
}
