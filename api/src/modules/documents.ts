import type { FastifyInstance } from 'fastify';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { q, q1, tx } from '../core/db.js';
import type { Row } from '../core/db.js';
import { require_, scopeSql } from '../core/rbac.js';
import { audit } from '../core/audit.js';
import { badRequest, notFound, forbidden } from '../core/errors.js';
import type { AuthCtx, Scope } from '../core/types.js';

/* ───────────────────────── validation & small helpers ───────────────────────── */

const uuid = z.string().uuid();
const idParam = z.object({ id: uuid });
const pdfQuery = z.object({ format: z.enum(['pdf', 'html']).default('pdf') });

function parse<S extends z.ZodTypeAny>(schema: S, data: unknown): z.infer<S> {
  const r = schema.safeParse(data ?? {});
  if (!r.success) {
    throw badRequest('validation_failed', 'Check the highlighted fields',
      r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
  }
  return r.data;
}

const txCtx = (ctx: AuthCtx, scope: Scope) => ({
  userId: ctx.userId, employeeId: ctx.employeeId, sbuId: ctx.sbuIds[0] ?? null, scope,
});

/** Same record scope as the quotation module: owner, SBU/team via the enquiry, and explicit shares. */
function quoteScope(ctx: AuthCtx, scope: Scope, startIdx: number): { sql: string; params: any[] } {
  const own = scopeSql(ctx, scope, { alias: 'q', ownerCol: 'owner_id', entity: 'quotations' }, startIdx);
  if ((scope === 'S' || scope === 'T') && ctx.sbuIds.length) {
    const i = startIdx + own.params.length;
    return { sql: `(${own.sql} OR e.primary_sbu_id = ANY($${i}::uuid[]))`, params: [...own.params, ctx.sbuIds] };
  }
  return own;
}

const COUNTRY: Record<string, string> = { AE: 'United Arab Emirates', IN: 'India', SA: 'Saudi Arabia', QA: 'Qatar', OM: 'Oman', KW: 'Kuwait', BH: 'Bahrain' };

const fmt = (n: number | string | null | undefined) =>
  Number(n ?? 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtQty = (n: number | string) =>
  Number(n).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 3 });
const fmtPct = (n: number | string) =>
  Number(n).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
const fmtDate = (d: string | Date | null | undefined) => {
  if (!d) return '';
  const s = typeof d === 'string' ? d.slice(0, 10) : d.toISOString().slice(0, 10);
  const [y, m, day] = s.split('-');
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${Number(day)} ${months[Number(m) - 1]} ${y}`;
};

const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

/* ───────────────────────── data for the customer document ───────────────────────── */

interface QuoteDoc {
  head: Row;
  lines: Row[];
  totals: { subtotal: number; vat: number; total: number; vatLabel: string };
}

/**
 * Loads exactly what the customer may see. Cost and margin are never selected, so no permission
 * mistake further down can put them on the page.
 */
async function loadQuoteDoc(ctx: AuthCtx, scope: Scope, versionId: string): Promise<QuoteDoc> {
  const sc = quoteScope(ctx, scope, 2);
  const head = await q1(
    `SELECT v.id AS version_id, v.version_no, v.status::text AS status, v.quote_date::text AS quote_date,
            v.valid_until::text AS valid_until, v.currency, v.payment_terms, v.delivery_terms, v.scope,
            v.assumptions, v.exclusions, v.warranty, v.commercial_terms,
            q.id AS quotation_id, q.quotation_no, q.owner_id, ow.full_name AS prepared_by,
            e.enquiry_no, e.title AS enquiry_title, e.end_customer_name,
            cu.name AS customer_name, cu.location AS customer_location, cu.country AS customer_country,
            cu.tax_registration AS customer_trn,
            cc.full_name AS contact_name, cc.designation AS contact_designation,
            co.name AS company_name, co.country AS company_country, co.tax_registration AS company_trn
       FROM gw.quotation_versions v
       JOIN gw.quotations q ON q.id = v.quotation_id
       JOIN gw.enquiries e ON e.id = q.enquiry_id
       JOIN gw.customers cu ON cu.id = q.customer_id
       JOIN gw.companies co ON co.id = q.company_id
       JOIN gw.employees ow ON ow.id = q.owner_id
       LEFT JOIN gw.customer_contacts cc ON cc.id = e.contact_id
      WHERE v.id = $1 AND ${sc.sql}`, [versionId, ...sc.params]);
  if (!head) throw notFound('Quotation version');

  const lines = await q(
    `SELECT l.line_no, l.description, l.part_number, l.quantity, l.unit_price, l.discount_pct, l.line_sell,
            COALESCE(tc.rate_pct, 0) AS tax_rate_pct
       FROM gw.quotation_lines l LEFT JOIN gw.tax_codes tc ON tc.id = l.tax_code_id
      WHERE l.quotation_version_id = $1 ORDER BY l.line_no`, [versionId]);

  // Arithmetic in SQL, from the lines themselves.
  const t = (await q1(
    `SELECT ROUND(COALESCE(SUM(l.line_sell), 0), 2) AS subtotal,
            ROUND(COALESCE(SUM(l.line_sell * COALESCE(tc.rate_pct, 0) / 100), 0), 2) AS vat,
            ROUND(COALESCE(SUM(l.line_sell), 0), 2) + ROUND(COALESCE(SUM(l.line_sell * COALESCE(tc.rate_pct, 0) / 100), 0), 2) AS total,
            COUNT(DISTINCT COALESCE(tc.rate_pct, 0)) AS n_rates, MAX(COALESCE(tc.rate_pct, 0)) AS rate
       FROM gw.quotation_lines l LEFT JOIN gw.tax_codes tc ON tc.id = l.tax_code_id
      WHERE l.quotation_version_id = $1`, [versionId]))!;
  return {
    head, lines,
    totals: {
      subtotal: t.subtotal, vat: t.vat, total: t.total,
      vatLabel: Number(t.n_rates) <= 1 ? `VAT (${fmtPct(t.rate)}%)` : 'VAT',
    },
  };
}

const statusLabel = (status: string) =>
  status === 'Submitted' ? '' : status === 'Superseded' ? 'SUPERSEDED' : 'DRAFT - NOT ISSUED';

const TERM_SECTIONS: [string, string][] = [
  ['Payment terms', 'payment_terms'], ['Delivery terms', 'delivery_terms'], ['Scope', 'scope'],
  ['Assumptions', 'assumptions'], ['Exclusions', 'exclusions'], ['Warranty', 'warranty'],
  ['Commercial terms', 'commercial_terms'],
];

/* ───────────────────────── minimal PDF 1.4 writer ───────────────────────── */

// Helvetica / Helvetica-Bold advance widths (1/1000 em) for ASCII 32..126, from the standard AFM metrics.
const W_REG = [278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,
  1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,
  333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500,334,260,334,584];
const W_BOLD = [278,333,474,556,556,889,722,238,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,333,333,584,584,584,611,
  975,722,722,722,722,667,611,778,722,278,556,722,611,833,722,778,667,778,722,667,611,722,667,944,667,667,611,333,278,333,584,556,
  333,556,611,556,611,556,333,611,611,278,278,556,278,889,611,611,611,611,389,556,333,611,556,778,556,556,500,389,280,389,584];

/** Unicode → WinAnsi (cp1252) byte for the characters that differ from Latin-1; anything else becomes '?'. */
const WIN_ANSI: Record<number, number> = {
  0x20AC: 0x80, 0x201A: 0x82, 0x0192: 0x83, 0x201E: 0x84, 0x2026: 0x85, 0x2020: 0x86, 0x2021: 0x87, 0x02C6: 0x88,
  0x2030: 0x89, 0x0160: 0x8A, 0x2039: 0x8B, 0x0152: 0x8C, 0x017D: 0x8E, 0x2018: 0x91, 0x2019: 0x92, 0x201C: 0x93,
  0x201D: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97, 0x02DC: 0x98, 0x2122: 0x99, 0x0161: 0x9A, 0x203A: 0x9B,
  0x0153: 0x9C, 0x017E: 0x9E, 0x0178: 0x9F,
};
function toWinAnsi(s: string): number[] {
  const out: number[] = [];
  for (const ch of s.replace(/\r/g, '')) {
    const cp = ch.codePointAt(0)!;
    if (cp >= 32 && cp <= 126) out.push(cp);
    else if (cp === 0x09) out.push(32, 32, 32, 32);
    else if (cp >= 0xA0 && cp <= 0xFF) out.push(cp);
    else if (WIN_ANSI[cp] !== undefined) out.push(WIN_ANSI[cp]);
    else if (cp === 0x00A0) out.push(32);
    else if (cp >= 32) out.push(63);
  }
  return out;
}
function textWidth(s: string, size: number, bold = false): number {
  const tbl = bold ? W_BOLD : W_REG;
  let w = 0;
  for (const b of toWinAnsi(s)) w += b >= 32 && b <= 126 ? tbl[b - 32] : 556;
  return (w * size) / 1000;
}
/** A PDF string literal built from ASCII only: bytes above 126 and the delimiters are octal-escaped. */
function pdfString(s: string): string {
  let out = '(';
  for (const b of toWinAnsi(s)) {
    if (b === 0x28 || b === 0x29 || b === 0x5C) out += '\\' + String.fromCharCode(b);
    else if (b < 32 || b > 126) out += '\\' + b.toString(8).padStart(3, '0');
    else out += String.fromCharCode(b);
  }
  return out + ')';
}
/** Greedy word wrap to a pixel width; honours explicit newlines and breaks over-long words. */
function wrap(text: string, width: number, size: number, bold = false): string[] {
  const out: string[] = [];
  for (const para of String(text ?? '').replace(/\r/g, '').split('\n')) {
    if (!para.trim()) { out.push(''); continue; }
    let cur = '';
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const next = cur ? `${cur} ${word}` : word;
      if (textWidth(next, size, bold) <= width) { cur = next; continue; }
      if (cur) out.push(cur);
      if (textWidth(word, size, bold) <= width) { cur = word; continue; }
      let piece = '';
      for (const ch of word) {
        if (textWidth(piece + ch, size, bold) > width && piece) { out.push(piece); piece = ''; }
        piece += ch;
      }
      cur = piece;
    }
    if (cur) out.push(cur);
  }
  return out;
}

const PAGE_W = 595, PAGE_H = 842, MARGIN = 40, CONTENT_W = PAGE_W - MARGIN * 2, BOTTOM = 56;
type Rgb = [number, number, number];
const INK: Rgb = [0.1, 0.1, 0.12], GREY: Rgb = [0.4, 0.4, 0.45], GREEN: Rgb = [0.05, 0.37, 0.25], RULE: Rgb = [0.8, 0.82, 0.8];

class Pdf {
  private pages: string[][] = [[]];
  private text: string[] = [];
  y = PAGE_H - MARGIN;
  private get ops() { return this.pages[this.pages.length - 1]; }
  get pageNo() { return this.pages.length; }

  newPage() { this.pages.push([]); this.y = PAGE_H - MARGIN; }
  /** Starts a new page if fewer than `h` points remain above the footer. Returns true when it did. */
  ensure(h: number): boolean {
    if (this.y - h < BOTTOM) { this.newPage(); return true; }
    return false;
  }
  draw(s: string, x: number, y: number, size: number, o: { bold?: boolean; color?: Rgb; align?: 'l' | 'r' | 'c'; width?: number } = {}) {
    if (!s) return;
    const w = textWidth(s, size, o.bold);
    const px = o.align === 'r' ? x + (o.width ?? 0) - w : o.align === 'c' ? x + ((o.width ?? 0) - w) / 2 : x;
    const c = o.color ?? INK;
    this.ops.push(`BT ${c[0]} ${c[1]} ${c[2]} rg /${o.bold ? 'F2' : 'F1'} ${size} Tf ${px.toFixed(2)} ${y.toFixed(2)} Td ${pdfString(s)} Tj ET`);
    this.text.push(s);
  }
  line(x1: number, y1: number, x2: number, y2: number, color: Rgb = RULE, w = 0.5) {
    this.ops.push(`${color[0]} ${color[1]} ${color[2]} RG ${w} w ${x1.toFixed(2)} ${y1.toFixed(2)} m ${x2.toFixed(2)} ${y2.toFixed(2)} l S`);
  }
  rect(x: number, y: number, w: number, h: number, color: Rgb) {
    this.ops.push(`${color[0]} ${color[1]} ${color[2]} rg ${x.toFixed(2)} ${y.toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)} re f`);
  }
  plainText() { return this.text.join('\n'); }

  /** Assembles the file. The body is pure ASCII, so string length equals byte length for the xref offsets. */
  build(footerLeft: string, info: { title: string; author: string }): Buffer {
    const total = this.pages.length;
    this.pages.forEach((ops, i) => {
      // Footer is drawn per page here, once the page count is known.
      ops.push(`${RULE[0]} ${RULE[1]} ${RULE[2]} RG 0.5 w ${MARGIN} 44 m ${PAGE_W - MARGIN} 44 l S`);
      const f = (s: string, x: number, align: 'l' | 'r') => {
        const w = textWidth(s, 8);
        ops.push(`BT ${GREY[0]} ${GREY[1]} ${GREY[2]} rg /F1 8 Tf ${(align === 'r' ? x - w : x).toFixed(2)} 32 Td ${pdfString(s)} Tj ET`);
      };
      f(footerLeft, MARGIN, 'l');
      f(`Page ${i + 1} of ${total}`, PAGE_W - MARGIN, 'r');
    });

    const objs: string[] = [];
    // 1 Catalog, 2 Pages, 3 Helvetica, 4 Helvetica-Bold, then (page, content) pairs, then Info.
    const firstPage = 5;
    const kids = this.pages.map((_, i) => `${firstPage + i * 2} 0 R`).join(' ');
    objs.push('<< /Type /Catalog /Pages 2 0 R >>');
    objs.push(`<< /Type /Pages /Kids [${kids}] /Count ${total} >>`);
    objs.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
    objs.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
    this.pages.forEach((ops, i) => {
      const content = ops.join('\n');
      objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${firstPage + i * 2 + 1} 0 R >>`);
      objs.push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
    });
    const infoNo = objs.length + 1;
    objs.push(`<< /Title ${pdfString(info.title)} /Author ${pdfString(info.author)} /Producer (Greenware ERP) >>`);

    let out = '%PDF-1.4\n';
    const offsets: number[] = [];
    objs.forEach((body, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${body}\nendobj\n`; });
    const xref = out.length;
    out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
    for (const off of offsets) out += `${String(off).padStart(10, '0')} 00000 n \n`;
    out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R /Info ${infoNo} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    return Buffer.from(out, 'latin1');
  }
}

/* ───────────────────────── quotation PDF layout ───────────────────────── */

function renderQuotationPdf(d: QuoteDoc): { pdf: Buffer; text: string } {
  const { head: h, lines, totals } = d;
  const doc = new Pdf();
  const ccy = String(h.currency).trim();
  const mark = statusLabel(h.status);

  // Letterhead
  doc.draw(h.company_name, MARGIN, doc.y - 14, 17, { bold: true, color: GREEN });
  const sub = [COUNTRY[h.company_country] ?? h.company_country, h.company_trn ? `TRN ${h.company_trn}` : ''].filter(Boolean).join('   |   ');
  doc.draw(sub, MARGIN, doc.y - 28, 8.5, { color: GREY });
  doc.draw('QUOTATION', MARGIN, doc.y - 16, 20, { bold: true, align: 'r', width: CONTENT_W });
  if (mark) doc.draw(mark, MARGIN, doc.y - 30, 9, { bold: true, color: [0.75, 0.1, 0.1], align: 'r', width: CONTENT_W });
  doc.line(MARGIN, doc.y - 40, PAGE_W - MARGIN, doc.y - 40, GREEN, 1.2);
  doc.y -= 58;

  // Customer block (left) and reference block (right)
  const top = doc.y;
  let ly = top;
  doc.draw('QUOTATION TO', MARGIN, ly, 7.5, { bold: true, color: GREY }); ly -= 13;
  doc.draw(h.customer_name, MARGIN, ly, 11, { bold: true }); ly -= 13;
  const place = [h.customer_location, COUNTRY[h.customer_country] ?? h.customer_country].filter(Boolean).join(', ');
  if (place) { doc.draw(place, MARGIN, ly, 9); ly -= 12; }
  if (h.customer_trn) { doc.draw(`TRN ${h.customer_trn}`, MARGIN, ly, 9); ly -= 12; }
  if (h.contact_name) {
    doc.draw(`Attn: ${h.contact_name}${h.contact_designation ? `, ${h.contact_designation}` : ''}`, MARGIN, ly, 9); ly -= 12;
  }
  if (h.end_customer_name) {
    doc.draw('End customer: ', MARGIN, ly, 9, { color: GREY });
    doc.draw(h.end_customer_name, MARGIN + textWidth('End customer: ', 9), ly, 9, { bold: true }); ly -= 12;
  }

  const kv: [string, string][] = [
    ['Quotation no.', h.quotation_no], ['Version', `v${h.version_no}`], ['Date', fmtDate(h.quote_date)],
    ['Valid until', h.valid_until ? fmtDate(h.valid_until) : '-'], ['Enquiry ref.', h.enquiry_no],
    ['Currency', ccy], ['Prepared by', h.prepared_by],
  ];
  let ry = top;
  const kx = 350;
  for (const [k, v] of kv) {
    doc.draw(k, kx, ry, 8.5, { color: GREY });
    doc.draw(v, kx + 75, ry, 9, { bold: k === 'Quotation no.' || k === 'Version' });
    ry -= 13;
  }
  doc.y = Math.min(ly, ry) - 8;

  if (h.enquiry_title) {
    for (const [i, ln] of wrap(h.enquiry_title, CONTENT_W - 50, 10, true).entries()) {
      if (i === 0) doc.draw('Subject:', MARGIN, doc.y, 9, { color: GREY });
      doc.draw(ln, MARGIN + 50, doc.y, 10, { bold: true }); doc.y -= 13;
    }
    doc.y -= 4;
  }

  // Line table
  const cols = { no: MARGIN, desc: MARGIN + 24, part: MARGIN + 214, qty: MARGIN + 292, price: MARGIN + 332, disc: MARGIN + 402, total: MARGIN + 445 };
  const colW = { no: 20, desc: 186, part: 74, qty: 36, price: 66, disc: 38, total: CONTENT_W - 445 };
  const tableHeader = () => {
    doc.rect(MARGIN, doc.y - 15, CONTENT_W, 18, GREEN);
    const hy = doc.y - 9;
    const W: Rgb = [1, 1, 1];
    doc.draw('#', cols.no + 3, hy, 8, { bold: true, color: W });
    doc.draw('Description', cols.desc, hy, 8, { bold: true, color: W });
    doc.draw('Part number', cols.part, hy, 8, { bold: true, color: W });
    doc.draw('Qty', cols.qty, hy, 8, { bold: true, color: W, align: 'r', width: colW.qty });
    doc.draw(`Unit price`, cols.price, hy, 8, { bold: true, color: W, align: 'r', width: colW.price });
    doc.draw('Disc %', cols.disc, hy, 8, { bold: true, color: W, align: 'r', width: colW.disc });
    doc.draw(`Total (${ccy})`, cols.total, hy, 8, { bold: true, color: W, align: 'r', width: colW.total });
    doc.y -= 20;
  };
  doc.ensure(60);
  tableHeader();
  lines.forEach((l, i) => {
    const desc = wrap(l.description, colW.desc - 4, 8.5);
    const part = wrap(l.part_number ?? '', colW.part - 4, 8.5);
    const n = Math.max(desc.length, part.length, 1);
    const rowH = n * 11 + 6;
    if (doc.ensure(rowH + 4)) tableHeader();
    const base = doc.y - 9;
    doc.draw(String(i + 1), cols.no + 3, base, 8.5);
    desc.forEach((s, k) => doc.draw(s, cols.desc, base - k * 11, 8.5));
    part.forEach((s, k) => doc.draw(s, cols.part, base - k * 11, 8.5));
    doc.draw(fmtQty(l.quantity), cols.qty, base, 8.5, { align: 'r', width: colW.qty });
    doc.draw(fmt(l.unit_price), cols.price, base, 8.5, { align: 'r', width: colW.price });
    doc.draw(Number(l.discount_pct) ? fmtPct(l.discount_pct) : '-', cols.disc, base, 8.5, { align: 'r', width: colW.disc });
    doc.draw(fmt(l.line_sell), cols.total, base, 8.5, { align: 'r', width: colW.total, bold: true });
    doc.line(MARGIN, doc.y - rowH + 2, PAGE_W - MARGIN, doc.y - rowH + 2);
    doc.y -= rowH;
  });
  if (!lines.length) { doc.draw('No lines on this version.', cols.desc, doc.y - 10, 9, { color: GREY }); doc.y -= 18; }

  // Totals
  doc.ensure(70);
  doc.y -= 6;
  const lx = MARGIN + 300, lw = CONTENT_W - 300;
  const trow = (label: string, val: string, bold = false, size = 9.5) => {
    doc.draw(label, lx, doc.y - 10, size, { bold });
    doc.draw(val, lx, doc.y - 10, size, { bold, align: 'r', width: lw });
    doc.y -= 15;
  };
  trow('Subtotal', `${ccy} ${fmt(totals.subtotal)}`);
  trow(totals.vatLabel, `${ccy} ${fmt(totals.vat)}`);
  doc.line(lx, doc.y + 2, PAGE_W - MARGIN, doc.y + 2, INK, 0.8);
  doc.y -= 4;
  trow('TOTAL', `${ccy} ${fmt(totals.total)}`, true, 11);
  doc.y -= 10;

  // Terms
  for (const [title, key] of TERM_SECTIONS) {
    const body = String(h[key] ?? '').trim();
    if (!body) continue;
    const ls = wrap(body, CONTENT_W, 9);
    doc.ensure(13 + Math.min(ls.length, 3) * 12 + 6); // keep a heading with at least a few lines of its text
    doc.draw(title, MARGIN, doc.y - 10, 10, { bold: true, color: GREEN });
    doc.y -= 15;
    for (const ln of ls) {
      if (doc.ensure(12)) { doc.draw(`${title} (continued)`, MARGIN, doc.y - 10, 9, { bold: true, color: GREY }); doc.y -= 14; }
      doc.draw(ln, MARGIN, doc.y - 9, 9);
      doc.y -= 12;
    }
    doc.y -= 6;
  }

  const pdf = doc.build(`${h.quotation_no}  -  Version ${h.version_no}${mark ? `  -  ${mark}` : ''}`, {
    title: `Quotation ${h.quotation_no} v${h.version_no}`, author: h.company_name,
  });
  return { pdf, text: doc.plainText() };
}

/* ───────────────────────── quotation HTML (?format=html) ───────────────────────── */

const PAGE_CSS = `
  body{font:14px/1.45 Helvetica,Arial,sans-serif;color:#1a1a1f;margin:0;background:#f4f5f4}
  .sheet{max-width:820px;margin:24px auto;background:#fff;padding:36px 40px;box-shadow:0 1px 4px rgba(0,0,0,.12)}
  h1{font-size:26px;margin:0;text-align:right} h2{font-size:14px;color:#0d5e40;margin:22px 0 4px}
  .co{font-size:22px;font-weight:700;color:#0d5e40} .muted{color:#666;font-size:12px}
  .top{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:3px solid #0d5e40;padding-bottom:12px}
  .cols{display:flex;justify-content:space-between;gap:24px;margin:16px 0} .cols>div{flex:1}
  table{width:100%;border-collapse:collapse;margin-top:12px;font-size:13px}
  th{background:#0d5e40;color:#fff;text-align:left;padding:6px 8px;font-size:12px} td{padding:6px 8px;border-bottom:1px solid #ddd;vertical-align:top}
  .r{text-align:right} .mark{color:#bf1a1a;font-weight:700;text-align:right}
  .tot{width:320px;margin-left:auto} .tot td{border:0;padding:3px 8px} .grand td{border-top:2px solid #1a1a1f;font-weight:700;font-size:15px}
  .pre{white-space:pre-wrap} kbd{font:inherit}
  @media print{body{background:#fff}.sheet{box-shadow:none;margin:0;padding:0}}`;

function renderQuotationHtml(d: QuoteDoc): string {
  const { head: h, lines, totals } = d;
  const ccy = esc(String(h.currency).trim());
  const mark = statusLabel(h.status);
  const place = [h.customer_location, COUNTRY[h.customer_country] ?? h.customer_country].filter(Boolean).join(', ');
  const rows = lines.map((l, i) => `<tr><td>${i + 1}</td><td class="pre">${esc(l.description)}</td><td>${esc(l.part_number ?? '')}</td>
    <td class="r">${fmtQty(l.quantity)}</td><td class="r">${fmt(l.unit_price)}</td>
    <td class="r">${Number(l.discount_pct) ? fmtPct(l.discount_pct) : '-'}</td><td class="r"><b>${fmt(l.line_sell)}</b></td></tr>`).join('');
  const terms = TERM_SECTIONS.filter(([, k]) => String(h[k] ?? '').trim())
    .map(([title, k]) => `<h2>${esc(title)}</h2><div class="pre">${esc(h[k])}</div>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Quotation ${esc(h.quotation_no)} v${h.version_no}</title><style>${PAGE_CSS}</style></head><body><div class="sheet">
<div class="top"><div><div class="co">${esc(h.company_name)}</div>
<div class="muted">${esc([COUNTRY[h.company_country] ?? h.company_country, h.company_trn ? `TRN ${h.company_trn}` : ''].filter(Boolean).join('  |  '))}</div></div>
<div><h1>QUOTATION</h1>${mark ? `<div class="mark">${esc(mark)}</div>` : ''}</div></div>
<div class="cols"><div><div class="muted">QUOTATION TO</div><b>${esc(h.customer_name)}</b><br>${esc(place)}
${h.customer_trn ? `<br>TRN ${esc(h.customer_trn)}` : ''}${h.contact_name ? `<br>Attn: ${esc(h.contact_name)}${h.contact_designation ? `, ${esc(h.contact_designation)}` : ''}` : ''}
${h.end_customer_name ? `<br>End customer: <b>${esc(h.end_customer_name)}</b>` : ''}</div>
<div><table style="margin:0"><tr><td class="muted">Quotation no.</td><td><b>${esc(h.quotation_no)}</b></td></tr>
<tr><td class="muted">Version</td><td><b>v${h.version_no}</b></td></tr><tr><td class="muted">Date</td><td>${fmtDate(h.quote_date)}</td></tr>
<tr><td class="muted">Valid until</td><td>${h.valid_until ? fmtDate(h.valid_until) : '-'}</td></tr>
<tr><td class="muted">Enquiry ref.</td><td>${esc(h.enquiry_no)}</td></tr><tr><td class="muted">Currency</td><td>${ccy}</td></tr>
<tr><td class="muted">Prepared by</td><td>${esc(h.prepared_by)}</td></tr></table></div></div>
${h.enquiry_title ? `<p><span class="muted">Subject:</span> <b>${esc(h.enquiry_title)}</b></p>` : ''}
<table><thead><tr><th>#</th><th>Description</th><th>Part number</th><th class="r">Qty</th><th class="r">Unit price</th><th class="r">Disc %</th><th class="r">Total (${ccy})</th></tr></thead>
<tbody>${rows || '<tr><td colspan="7" class="muted">No lines on this version.</td></tr>'}</tbody></table>
<table class="tot"><tr><td>Subtotal</td><td class="r">${ccy} ${fmt(totals.subtotal)}</td></tr>
<tr><td>${esc(totals.vatLabel)}</td><td class="r">${ccy} ${fmt(totals.vat)}</td></tr>
<tr class="grand"><td>TOTAL</td><td class="r">${ccy} ${fmt(totals.total)}</td></tr></table>${terms}</div></body></html>`;
}

/* ───────────────────────── supplier RFQ (HTML) ───────────────────────── */

const RFQ_TERMS = [
  'Please quote in your currency of sale and state it clearly, with unit price, line total and applicable taxes shown separately.',
  'State your quotation validity (minimum 30 days), lead time or stock availability for each line, and Incoterms for delivery.',
  'State your payment terms and any warranty or support period that applies to the items.',
  'Alternatives are welcome but must be clearly marked and quoted separately from the items requested.',
  'This request is not an order. Greenware Technologies LLC is bound only by a signed purchase order.',
  'The contents of this request are confidential and are to be used only to prepare your quotation.',
];

async function renderRfq(ctx: AuthCtx, scope: Scope, versionId: string): Promise<string> {
  const sc = quoteScope(ctx, scope, 2);
  const h = await q1(
    `SELECT v.version_no, q.id AS quotation_id, q.quotation_no, q.enquiry_id, co.name AS company_name,
            co.country AS company_country, co.tax_registration AS company_trn, ow.full_name AS contact_name, ow_u.email AS contact_email
       FROM gw.quotation_versions v
       JOIN gw.quotations q ON q.id = v.quotation_id
       JOIN gw.enquiries e ON e.id = q.enquiry_id
       JOIN gw.companies co ON co.id = q.company_id
       JOIN gw.employees ow ON ow.id = q.owner_id
       LEFT JOIN gw.users ow_u ON ow_u.id = ow.user_id
      WHERE v.id = $1 AND ${sc.sql}`, [versionId, ...sc.params]);
  if (!h) throw notFound('Quotation version');

  // Only goods are sourced from suppliers. No price, cost, margin or customer name ever goes in this document.
  const lines = await q(
    `SELECT l.description, l.part_number, l.quantity, m.name AS manufacturer, COALESCE(k.uom, 'EA') AS uom
       FROM gw.quotation_lines l
       LEFT JOIN gw.manufacturers m ON m.id = l.manufacturer_id
       LEFT JOIN gw.product_skus k ON k.id = l.product_sku_id
      WHERE l.quotation_version_id = $1 AND l.service_id IS NULL AND l.technical_estimate_id IS NULL
      ORDER BY l.line_no`, [versionId]);
  const pr = await q1(
    `SELECT request_no, required_by::text AS required_by FROM gw.procurement_requests
      WHERE enquiry_id = $1 ORDER BY raised_at DESC LIMIT 1`, [h.enquiry_id]);

  const rows = lines.map((l, i) => `<tr><td>${i + 1}</td><td>${esc(l.manufacturer ?? '')}</td><td>${esc(l.part_number ?? '')}</td>
    <td class="pre">${esc(l.description)}</td><td class="r">${fmtQty(l.quantity)}</td><td>${esc(l.uom)}</td></tr>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Request for Quotation ${esc(pr?.request_no ?? h.quotation_no)}</title><style>${PAGE_CSS}</style></head><body><div class="sheet">
<div class="top"><div><div class="co">${esc(h.company_name)}</div>
<div class="muted">${esc([COUNTRY[h.company_country] ?? h.company_country, h.company_trn ? `TRN ${h.company_trn}` : ''].filter(Boolean).join('  |  '))}</div></div>
<div><h1>REQUEST FOR QUOTATION</h1></div></div>
<div class="cols"><div><table style="margin:0">
<tr><td class="muted">Our reference</td><td><b>${esc(pr?.request_no ?? h.quotation_no)}</b></td></tr>
<tr><td class="muted">Quotation ref.</td><td>${esc(h.quotation_no)} / v${h.version_no}</td></tr>
<tr><td class="muted">Required by</td><td><b>${pr?.required_by ? fmtDate(pr.required_by) : 'As soon as possible'}</b></td></tr>
<tr><td class="muted">Contact</td><td>${esc(h.contact_name)}${h.contact_email ? ` &lt;${esc(h.contact_email)}&gt;` : ''}</td></tr></table></div></div>
<h2>Items requested</h2>
<table><thead><tr><th>#</th><th>Manufacturer</th><th>Part number</th><th>Description</th><th class="r">Qty</th><th>UoM</th></tr></thead>
<tbody>${rows || '<tr><td colspan="6" class="muted">This version has no goods lines to source.</td></tr>'}</tbody></table>
<h2>Terms of this request</h2><ol>${RFQ_TERMS.map((t) => `<li>${esc(t)}</li>`).join('')}</ol></div></body></html>`;
}

/* ───────────────────────── persistence of the generated file ───────────────────────── */

const STORE_DIR = process.env.DOCUMENT_STORE_DIR ?? path.resolve(process.cwd(), 'storage');

// ───────────────────────── routes ─────────────────────────

export async function documentRoutes(app: FastifyInstance) {
  app.get('/api/v1/quotation-versions/:id/pdf', async (req, reply) => {
    const ctx = req.auth;
    const scope = require_(ctx, 'quotations.export');
    const { id } = parse(idParam, req.params);
    const { format } = parse(pdfQuery, req.query);

    const d = await loadQuoteDoc(ctx, scope, id);
    // The document carries prices, so a caller who may not see prices on this record may not export it either.
    const own = d.head.owner_id === ctx.employeeId;
    if (!(ctx.fields.has('sell_price') || (own && ctx.fieldsOwnOnly.has('sell_price')))) {
      throw forbidden('You do not have access to prices on this quotation, so you cannot export it.');
    }
    const baseName = `${d.head.quotation_no}-v${d.head.version_no}`;

    if (format === 'html') {
      const html = renderQuotationHtml(d);
      await tx(txCtx(ctx, scope), (c) => audit(c, ctx, {
        entityType: 'quotation_versions', entityId: id, action: 'export', newValue: `${baseName}.html`, ip: req.ip,
      }));
      return reply.header('Cache-Control', 'no-store').type('text/html; charset=utf-8').send(html);
    }

    const { pdf, text } = renderQuotationPdf(d);
    const hash = createHash('sha256').update(pdf).digest('hex');
    const fileName = `${baseName}.pdf`;
    const storageKey = `quotations/${new Date().getUTCFullYear()}/${baseName}-${hash.slice(0, 12)}.pdf`;

    // Keep the bytes where the storage key says; if the disk is unavailable the PDF can still be regenerated on demand.
    let key = storageKey;
    try {
      await mkdir(path.dirname(path.join(STORE_DIR, storageKey)), { recursive: true });
      await writeFile(path.join(STORE_DIR, storageKey), pdf);
    } catch (e) {
      req.log.warn({ err: e }, 'could not write generated quotation PDF to the document store');
      key = `regenerate/quotation_versions/${id}`;
    }

    await tx(txCtx(ctx, scope), async (c) => {
      await c.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`doc:${id}`]);
      const existing = (await c.query(
        `SELECT id, current_version FROM gw.documents
          WHERE entity_type = 'quotation_versions' AND entity_id = $1 AND doc_type = 'QUOTATION_PDF' FOR UPDATE`, [id])).rows[0];
      let documentId: string;
      if (!existing) {
        documentId = (await c.query(
          `INSERT INTO gw.documents (entity_type, entity_id, doc_type, title, current_version, created_by)
           VALUES ('quotation_versions', $1, 'QUOTATION_PDF', $2, 1, $3) RETURNING id`,
          [id, `Quotation ${d.head.quotation_no} v${d.head.version_no}`, ctx.userId])).rows[0].id;
        await c.query(
          `INSERT INTO gw.document_versions
             (document_id, version_no, file_name, mime_type, size_bytes, content_hash, storage_key, extracted_text, uploaded_by)
           VALUES ($1, 1, $2, 'application/pdf', $3, $4, $5, $6, $7)`,
          [documentId, fileName, pdf.length, hash, key, text, ctx.userId]);
        await audit(c, ctx, { entityType: 'documents', entityId: documentId, action: 'create', newValue: fileName });
      } else {
        documentId = existing.id;
        const last = (await c.query(
          `SELECT content_hash FROM gw.document_versions WHERE document_id = $1 ORDER BY version_no DESC LIMIT 1`, [documentId])).rows[0];
        // An unchanged document is not a new version; a changed draft is.
        if (!last || last.content_hash.trim() !== hash) {
          const next = Number(existing.current_version) + 1;
          await c.query(
            `INSERT INTO gw.document_versions
               (document_id, version_no, file_name, mime_type, size_bytes, content_hash, storage_key, extracted_text, replaced_reason, uploaded_by)
             VALUES ($1, $2, $3, 'application/pdf', $4, $5, $6, $7, 'Regenerated after the quotation changed', $8)`,
            [documentId, next, fileName, pdf.length, hash, key, text, ctx.userId]);
          await c.query(`UPDATE gw.documents SET current_version = $2 WHERE id = $1`, [documentId, next]);
        }
      }
      await audit(c, ctx, {
        entityType: 'quotation_versions', entityId: id, action: 'export', newValue: fileName, reason: `document ${documentId}`, ip: req.ip,
      });
    });

    return reply
      .header('Content-Disposition', `inline; filename="${fileName}"`)
      .header('Cache-Control', 'no-store')
      .type('application/pdf')
      .send(pdf);
  });

  app.get('/api/v1/quotation-versions/:id/rfq-preview', async (req, reply) => {
    const ctx = req.auth;
    const scope = require_(ctx, 'procurement_requests.view');
    const { id } = parse(idParam, req.params);
    const html = await renderRfq(ctx, scope, id);
    return reply.header('Cache-Control', 'no-store').type('text/html; charset=utf-8').send(html);
  });
}
