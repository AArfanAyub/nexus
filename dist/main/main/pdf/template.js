"use strict";
/* Copyright (c) 2026 arfanayub0. All rights reserved. Licensed under the NEXUS Proprietary Perpetual License. See LICENSE. */
Object.defineProperty(exports, "__esModule", { value: true });
exports.templateInternals = void 0;
exports.escapeHtml = escapeHtml;
exports.amountInWords = amountInWords;
exports.renderDocumentHtml = renderDocumentHtml;
exports.renderPreviewHtml = renderPreviewHtml;
/** Titles and column headers per document type — the only thing that differs. */
const VARIANTS = {
    invoice: { title: 'Tax Invoice', qtyLabel: 'Qty', priceLabel: 'Unit price', partnerLabel: 'Bill to' },
    bill: { title: 'Vendor Bill', qtyLabel: 'Qty', priceLabel: 'Unit price', partnerLabel: 'Supplier' },
    quote: { title: 'Quotation', qtyLabel: 'Qty', priceLabel: 'Unit price', partnerLabel: 'Prepared for' },
    purchase_order: { title: 'Purchase Order', qtyLabel: 'Qty', priceLabel: 'Unit price', partnerLabel: 'Supplier' },
    delivery_note: { title: 'Delivery Note', qtyLabel: 'Qty shipped', priceLabel: 'Unit price', partnerLabel: 'Deliver to' },
    credit_note: { title: 'Credit Note', qtyLabel: 'Qty', priceLabel: 'Unit price', partnerLabel: 'Credit to' },
    statement: { title: 'Statement of Account', qtyLabel: 'Qty', priceLabel: 'Unit price', partnerLabel: 'Customer' },
};
/** Escapes every character that could break out of text or an attribute. */
function escapeHtml(value) {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}
const ONES = [
    '', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
    'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen',
];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
function underThousand(value) {
    if (value === 0)
        return '';
    if (value < 20)
        return ONES[value] ?? '';
    if (value < 100) {
        const tens = TENS[Math.trunc(value / 10)] ?? '';
        const rest = value % 10;
        return rest === 0 ? tens : `${tens}-${ONES[rest] ?? ''}`;
    }
    const hundreds = `${ONES[Math.trunc(value / 100)] ?? ''} hundred`;
    const rest = value % 100;
    return rest === 0 ? hundreds : `${hundreds} and ${underThousand(rest)}`;
}
/**
 * Amount in words, as printed on an invoice. Integer arithmetic only: the cents
 * are split off with `%` and `Math.trunc`, never with a float.
 */
function amountInWords(valueCents, currency) {
    const negative = valueCents < 0;
    const magnitude = Math.abs(Math.trunc(valueCents));
    const whole = Math.trunc(magnitude / 100);
    const centsPart = magnitude % 100;
    const scales = [
        { value: 1_000_000_000, name: 'billion' },
        { value: 1_000_000, name: 'million' },
        { value: 1_000, name: 'thousand' },
        { value: 1, name: '' },
    ];
    const parts = [];
    let remaining = whole;
    for (const scale of scales) {
        const count = Math.trunc(remaining / scale.value);
        if (count === 0)
            continue;
        const words = underThousand(count);
        parts.push(scale.name ? `${words} ${scale.name}` : words);
        remaining -= count * scale.value;
    }
    const unitName = currency === 'USD' ? 'dollars' : currency === 'EUR' ? 'euros' : currency === 'GBP' ? 'pounds' : currency;
    const centName = currency === 'GBP' ? 'pence' : 'cents';
    if (whole === 0 && centsPart === 0)
        return `Zero ${unitName} only`;
    const wholeWords = parts.length > 0 ? `${parts.join(' ')} ${unitName}` : '';
    const centWords = centsPart === 0 ? '' : `${String(centsPart)} ${centName}`;
    const joined = [wholeWords, centWords].filter((part) => part.length > 0).join(' and ');
    const sentence = `${joined.charAt(0).toUpperCase()}${joined.slice(1)} only`;
    return negative ? `Minus ${sentence}` : sentence;
}
/**
 * The stylesheet as data, so the same rules can be emitted unscoped for the PDF
 * and scoped under `.doc-preview` for the in-app preview. Rewriting a finished
 * stylesheet with a regex is the kind of cleverness that breaks silently; a rule
 * list cannot.
 */
const RULES = [
    ['*', 'box-sizing: border-box;'],
    ['', 'margin: 0; padding: 0;'],
    ['body', 'font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; font-size: 10pt; color: #111; line-height: 1.35; background: #fff;'],
    ['.sheet', 'padding: 14mm 14mm 22mm; position: relative;'],
    ['.head', 'display: flex; justify-content: space-between; align-items: flex-start; gap: 12mm;'],
    ['.brand', 'display: flex; gap: 4mm; align-items: flex-start;'],
    ['.brand img', 'width: 18mm; height: 18mm; object-fit: contain;'],
    ['.brand-name', 'font-size: 15pt; font-weight: 700; letter-spacing: 0.2pt;'],
    ['.brand-meta', 'font-size: 8.5pt; color: #444; margin-top: 1mm;'],
    ['.doc-title', 'text-align: right;'],
    ['.doc-title h1', 'font-size: 17pt; margin: 0; letter-spacing: 1pt; text-transform: uppercase;'],
    ['.doc-title .number', 'font-size: 10pt; color: #333; margin-top: 1mm;'],
    ['.status', 'display: inline-block; margin-top: 2mm; padding: 0.8mm 3mm; border: 0.4mm solid #111; border-radius: 1mm; font-size: 8pt; text-transform: uppercase; letter-spacing: 0.6pt;'],
    ['.parties', 'display: flex; gap: 10mm; margin-top: 9mm;'],
    ['.party', 'flex: 1;'],
    ['.party h2', 'font-size: 8pt; text-transform: uppercase; letter-spacing: 0.8pt; color: #555; margin: 0 0 1.5mm; font-weight: 600;'],
    ['.party .name', 'font-weight: 600; font-size: 11pt;'],
    ['.party .line', 'font-size: 9pt; color: #333;'],
    ['table.lines', 'width: 100%; border-collapse: collapse; margin-top: 8mm;'],
    ['table.lines thead th', 'font-size: 8pt; text-transform: uppercase; letter-spacing: 0.5pt; color: #444; text-align: left; padding: 2mm 2mm; border-bottom: 0.4mm solid #111;'],
    ['table.lines td', 'padding: 2mm 2mm; border-bottom: 0.2mm solid #ddd; vertical-align: top; font-size: 9.5pt;'],
    ['table.lines td.num', 'text-align: right; white-space: nowrap;'],
    ['table.lines th.num', 'text-align: right; white-space: nowrap;'],
    ['table.lines td.detail', 'font-size: 8pt; color: #666;'],
    ['.summary', 'display: flex; justify-content: flex-end; margin-top: 5mm;'],
    ['.summary table', 'border-collapse: collapse; min-width: 68mm;'],
    ['.summary td', 'padding: 1.2mm 2mm; font-size: 9.5pt;'],
    ['.summary td.label', 'color: #444;'],
    ['.summary td.value', 'text-align: right; white-space: nowrap;'],
    ['.summary tr.grand td', 'border-top: 0.4mm solid #111; font-weight: 700; font-size: 11pt; padding-top: 2mm;'],
    ['.words', 'margin-top: 6mm; font-size: 9pt;'],
    ['.words span', 'text-transform: uppercase; letter-spacing: 0.4pt; color: #555; font-size: 8pt;'],
    ['.notes', 'margin-top: 5mm; font-size: 8.5pt; color: #333;'],
    ['.notes h3', 'font-size: 8pt; text-transform: uppercase; letter-spacing: 0.7pt; color: #555; margin: 0 0 1mm;'],
    ['.foot', 'display: flex; justify-content: space-between; font-size: 7.5pt; color: #666; border-top: 0.2mm solid #ccc; padding-top: 1.5mm; margin-top: 8mm;'],
    ['.foot.fixed', 'position: fixed; bottom: 8mm; left: 14mm; right: 14mm; margin-top: 0;'],
    ['.pg::after', 'content: counter(page) " / " counter(pages);'],
];
/** Emits the rules, optionally scoped under one ancestor selector. */
function stylesheet(scope) {
    const lines = RULES.map(([selector, body]) => {
        if (selector === '')
            return `${scope ? `${scope}` : 'html, body'} { ${body} }`;
        const target = scope ? selector.split(',').map((part) => `${scope} ${part.trim()}`).join(', ') : selector;
        return `${target} { ${body} }`;
    });
    return lines.join('\n');
}
function renderHead(model) {
    const variant = VARIANTS[model.docType];
    const company = model.company;
    const logo = company.logoDataUrl ? `<img src="${escapeHtml(company.logoDataUrl)}" alt="" />` : '';
    const address = (company.address ?? []).map((line) => `<div class="brand-meta">${escapeHtml(line)}</div>`).join('');
    const taxId = company.taxId ? `<div class="brand-meta">Tax ID ${escapeHtml(company.taxId)}</div>` : '';
    return `
    <div class="head">
      <div class="brand">
        ${logo}
        <div>
          <div class="brand-name">${escapeHtml(company.name)}</div>
          ${company.legalName ? `<div class="brand-meta">${escapeHtml(company.legalName)}</div>` : ''}
          ${address}
          ${taxId}
        </div>
      </div>
      <div class="doc-title">
        <h1>${escapeHtml(variant.title)}</h1>
        <div class="number">${escapeHtml(model.number)}</div>
        ${model.status ? `<div class="status">${escapeHtml(model.status)}</div>` : ''}
      </div>
    </div>`;
}
function renderParties(model) {
    const variant = VARIANTS[model.docType];
    const partnerLines = model.partner.lines
        .filter((line) => line.trim().length > 0)
        .map((line) => `<div class="line">${escapeHtml(line)}</div>`)
        .join('');
    const meta = model.meta
        .map((entry) => `<div class="line">${escapeHtml(entry.label)}: ${escapeHtml(entry.value)}</div>`)
        .join('');
    return `
    <div class="parties">
      <div class="party">
        <h2>${escapeHtml(variant.partnerLabel)}</h2>
        <div class="name">${escapeHtml(model.partner.name)}</div>
        ${partnerLines}
      </div>
      <div class="party">
        <h2>Details</h2>
        <div class="line">Date: ${escapeHtml(model.date)}</div>
        ${model.dueDate ? `<div class="line">Due: ${escapeHtml(model.dueDate)}</div>` : ''}
        ${model.reference ? `<div class="line">Reference: ${escapeHtml(model.reference)}</div>` : ''}
        <div class="line">Currency: ${escapeHtml(model.currency)}</div>
        ${meta}
      </div>
    </div>`;
}
function renderLines(model) {
    const variant = VARIANTS[model.docType];
    const rows = model.lines
        .map((line) => `
      <tr>
        <td>${escapeHtml(line.description)}${line.detail ? `<div class="detail">${escapeHtml(line.detail)}</div>` : ''}</td>
        <td class="num">${escapeHtml(line.qty)}</td>
        <td class="num">${escapeHtml(line.unitPrice)}</td>
        <td class="num">${escapeHtml(line.discount ?? '—')}</td>
        <td class="num">${escapeHtml(line.tax ?? '—')}</td>
        <td class="num">${escapeHtml(line.total)}</td>
      </tr>`)
        .join('');
    return `
    <table class="lines">
      <thead>
        <tr>
          <th>Description</th>
          <th class="num">${escapeHtml(variant.qtyLabel)}</th>
          <th class="num">${escapeHtml(variant.priceLabel)}</th>
          <th class="num">Discount</th>
          <th class="num">Tax</th>
          <th class="num">Amount</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;
}
function renderSummary(model) {
    const taxRows = model.taxRows
        .map((row) => `
      <tr><td class="label">${escapeHtml(row.label)}</td><td class="value">${escapeHtml(row.net)}</td>
          <td class="value">${escapeHtml(row.tax)}</td></tr>`)
        .join('');
    const totalRows = model.totals
        .map((row) => `
      <tr${row.emphasis ? ' class="grand"' : ''}><td class="label">${escapeHtml(row.label)}</td>
          <td class="value">${escapeHtml(row.value)}</td></tr>`)
        .join('');
    const taxBlock = taxRows
        ? `<table><tr><td class="label">Tax breakdown</td><td class="value">Net</td><td class="value">Tax</td></tr>${taxRows}</table>`
        : '';
    return `
    <div class="summary">
      <div>
        ${taxBlock}
        <table>${totalRows}</table>
      </div>
    </div>`;
}
function renderBody(model) {
    const notes = model.notes
        ? `<div class="notes"><h3>Notes</h3>${escapeHtml(model.notes)}</div>`
        : '';
    const terms = model.terms
        ? `<div class="notes"><h3>Terms</h3>${escapeHtml(model.terms)}</div>`
        : '';
    return `
    ${renderHead(model)}
    ${renderParties(model)}
    ${renderLines(model)}
    ${renderSummary(model)}
    <div class="words"><span>Amount in words</span><div>${escapeHtml(model.amountInWords)}</div></div>
    ${notes}
    ${terms}`;
}
/** A complete, standalone A4 document — what `printToPDF` receives. */
function renderDocumentHtml(model) {
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<title>${escapeHtml(VARIANTS[model.docType].title)} ${escapeHtml(model.number)}</title>
<style>${stylesheet('')}\n@page { size: A4; margin: 0; }</style>
</head>
<body><div class="sheet">${renderBody(model)}</div>
<div class="foot fixed"><span>${escapeHtml(model.company.name)}</span>
<span>${escapeHtml(model.number)}</span><span class="pg">Page </span></div>
</body></html>`;
}
/**
 * The same document as a body fragment with scoped styles, for the split-view
 * preview inside the app. `frame-src 'none'` in the CSP rules out an iframe, so
 * the fragment is injected into a container that scales it down.
 */
function renderPreviewHtml(model) {
    return `<style>${stylesheet('.doc-preview')}</style>
<div class="doc-preview"><div class="sheet">${renderBody(model)}</div>
<div class="foot"><span>${escapeHtml(model.company.name)}</span><span>${escapeHtml(model.number)}</span></div></div>`;
}
/** Exported for the tests: the template must never emit an unescaped tag. */
exports.templateInternals = { VARIANTS, RULES };
//# sourceMappingURL=template.js.map