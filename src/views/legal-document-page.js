'use strict';

function escapeHtml(value) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
/**
 * Standalone page for the store listings, which need a public link to the
 * privacy policy. All stored text is escaped: it is admin-authored plain text.
 */
function renderLegalDocumentPage(document, language) {
  const arabic = language === 'ar';
  const title = escapeHtml(arabic ? document.titleAr : document.titleEn);
  const updated = document.publishedAt ? document.publishedAt.toISOString().slice(0, 10) : '';
  const updatedLabel = arabic ? 'آخر تحديث' : 'Last updated';
  const versionLabel = arabic ? 'الإصدار' : 'Version';
  const sections = document.sections
    .map((section) => {
      const heading = escapeHtml(arabic ? section.headingAr : section.headingEn);
      const body = escapeHtml(arabic ? section.bodyAr : section.bodyEn);
      return `<section><h2>${heading}</h2><p>${body}</p></section>`;
    })
    .join('\n');
  return `<!doctype html>
<html lang="${language}" dir="${arabic ? 'rtl' : 'ltr'}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
body{margin:0;background:#F6F4EF;color:#1F2A24;font-family:-apple-system,"Segoe UI",Tahoma,Arial,sans-serif;line-height:1.8}
main{max-width:760px;margin:0 auto;padding:32px 16px 64px}
h1{font-size:1.6rem;margin:0 0 4px}
h2{font-size:1.1rem;margin:28px 0 8px}
p{margin:0;white-space:pre-line}
.meta{color:#6B7268;font-size:.9rem}
</style>
</head>
<body>
<main>
<h1>${title}</h1>
<div class="meta">${versionLabel} ${document.version}${updated ? ` · ${updatedLabel} ${updated}` : ''}</div>
${sections}
</main>
</body>
</html>`;
}

Object.assign(exports, { renderLegalDocumentPage });
