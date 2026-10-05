import { createRequire } from 'node:module';
import path from 'node:path';
import PDFDocument from 'pdfkit';
import { formatMoney, PAYMENT_LABEL, type ReportSummary, type StoreSettings } from '@sync-retail/shared';

// PDFKit's built-in fonts are WinAnsi-only (no ₦, ₹, ₵, ₱ …), so embed
// DejaVu, which covers every currency symbol. Fonts are subset per document.
const FONT_DIR = path.join(path.dirname(createRequire(import.meta.url).resolve('dejavu-fonts-ttf/package.json')), 'ttf');
const FONTS = {
  regular: path.join(FONT_DIR, 'DejaVuSans.ttf'),
  bold: path.join(FONT_DIR, 'DejaVuSans-Bold.ttf'),
  display: path.join(FONT_DIR, 'DejaVuSerif-Italic.ttf'),
};

const INK = '#16140F';
const MUTED = '#6B6455';
const ACCENT = '#B86E00';
const RULE = '#D9D1BF';

/** Renders the report summary as a printable A4 PDF and returns the bytes. */
export function reportToPdf(r: ReportSummary, settings: StoreSettings): Promise<Buffer> {
  const fmt = (c: number) => formatMoney(c, settings.currency, settings.locale);
  const doc = new PDFDocument({ size: 'A4', margin: 48, info: { Title: `${settings.storeName} sales report` } });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  doc.registerFont('Sans', FONTS.regular);
  doc.registerFont('Sans-Bold', FONTS.bold);
  doc.registerFont('Display', FONTS.display);

  const left = doc.page.margins.left;
  const width = doc.page.width - left - doc.page.margins.right;

  // Masthead
  doc.font('Sans-Bold').fontSize(9).fillColor(ACCENT).text(settings.storeName.toUpperCase(), { characterSpacing: 2 });
  doc.moveDown(0.3);
  doc.font('Display').fontSize(30).fillColor(INK).text('Sales report');
  doc
    .font('Sans')
    .fontSize(10)
    .fillColor(MUTED)
    .text(`${r.range.from.slice(0, 10)}  →  ${r.range.to.slice(0, 10)}   ·   by ${r.range.granularity}`);
  doc.moveDown(0.8);
  rule();

  // KPI strip
  const t = r.totals;
  const kpis: [string, string][] = [
    ['Net sales', fmt(t.netCents)],
    ['Transactions', String(t.transactions)],
    ['Avg ticket', fmt(t.averageTicketCents)],
    ['Gross margin', fmt(t.grossMarginCents)],
  ];
  const colW = width / kpis.length;
  const kpiY = doc.y + 8;
  kpis.forEach(([label, value], i) => {
    doc.font('Sans').fontSize(8).fillColor(MUTED).text(label.toUpperCase(), left + i * colW, kpiY, { width: colW, characterSpacing: 1 });
    doc.font('Sans-Bold').fontSize(16).fillColor(INK).text(value, left + i * colW, kpiY + 14, { width: colW });
  });
  doc.y = kpiY + 44;
  doc.x = left;
  doc
    .font('Sans')
    .fontSize(9)
    .fillColor(MUTED)
    .text(`Gross ${fmt(t.grossCents)} · Refunds ${fmt(t.refundedCents)} · Tax ${fmt(t.taxCents)} · Discounts ${fmt(t.discountCents)} · Items ${t.itemsSold}`);
  doc.moveDown(0.6);
  rule();

  // Bar chart of the series
  section(`Net sales by ${r.range.granularity}`);
  const chartH = 110;
  const chartY = doc.y + 4;
  const max = Math.max(1, ...r.series.map((s) => s.totalCents));
  const barW = r.series.length ? width / r.series.length : width;
  r.series.forEach((s, i) => {
    const h = (s.totalCents / max) * chartH;
    doc.rect(left + i * barW + barW * 0.15, chartY + chartH - h, barW * 0.7, h).fill(i === r.series.length - 1 ? ACCENT : INK);
  });
  doc.moveTo(left, chartY + chartH).lineTo(left + width, chartY + chartH).lineWidth(0.5).stroke(RULE);
  doc.y = chartY + chartH + 18;
  doc.x = left;

  table('Top products', ['Product', 'SKU', 'Qty', 'Revenue'], [0.5, 0.2, 0.1, 0.2],
    r.topProducts.map((p) => [p.name, p.sku, String(p.quantity), fmt(p.revenueCents)]));
  table('Categories', ['Category', 'Qty', 'Revenue'], [0.6, 0.15, 0.25],
    r.categories.map((c) => [c.name, String(c.quantity), fmt(c.revenueCents)]));
  table('Payment methods', ['Method', 'Count', 'Amount'], [0.6, 0.15, 0.25],
    r.payments.map((p) => [PAYMENT_LABEL[p.method], String(p.count), fmt(p.amountCents)]));
  table('Staff performance', ['Name', 'Sales', 'Net', 'Avg', 'Voids', 'Overr.'], [0.3, 0.1, 0.2, 0.2, 0.1, 0.1],
    r.workers.map((w) => [w.name, String(w.transactions), fmt(w.revenueCents), fmt(w.averageTicketCents), String(w.voids), String(w.overrides)]));

  doc.font('Sans').fontSize(8).fillColor(MUTED).text(`Generated ${new Date().toISOString()}`, left, doc.page.height - 40, { lineBreak: false });
  doc.end();

  return new Promise((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))));

  function rule() {
    doc.moveTo(left, doc.y).lineTo(left + width, doc.y).lineWidth(0.75).stroke(RULE);
    doc.moveDown(0.6);
  }
  function section(title: string) {
    if (doc.y > doc.page.height - 160) doc.addPage();
    doc.font('Display').fontSize(15).fillColor(INK).text(title, left);
    doc.moveDown(0.3);
  }
  function table(title: string, headers: string[], ratios: number[], rows: string[][]) {
    section(title);
    const draw = (cells: string[], bold: boolean, color: string) => {
      const y = doc.y;
      let x = left;
      cells.forEach((cell, i) => {
        const w = ratios[i] * width;
        doc.font(bold ? 'Sans-Bold' : 'Sans').fontSize(9).fillColor(color)
          .text(cell, x, y, { width: w - 6, align: i === 0 ? 'left' : 'right', lineBreak: false, ellipsis: true });
        x += w;
      });
      doc.y = y + 15;
    };
    draw(headers, true, MUTED);
    if (!rows.length) draw(['No data', ...headers.slice(1).map(() => '')], false, MUTED);
    rows.forEach((row) => {
      if (doc.y > doc.page.height - 70) doc.addPage();
      draw(row, false, INK);
    });
    doc.x = left;
    doc.moveDown(0.8);
  }
}
