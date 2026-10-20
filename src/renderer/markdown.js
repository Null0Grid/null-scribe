'use strict';

/* Minimal, safe Markdown → HTML for summaries: headings, lists, checkboxes, bold, italics, code.
   All input is HTML-escaped first, so model output can never inject markup. */
(function () {
  function esc(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function inline(s) {
    return esc(s)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
      .replace(/\[(\d{1,2}:\d{2}(?::\d{2})?)\]/g, '<span class="ts">$1</span>');
  }

  function render(md) {
    const lines = String(md || '').replace(/\r\n/g, '\n').split('\n');
    const out = [];
    let list = null; // 'ul' | 'ol'
    let para = [];

    const flushPara = () => {
      if (para.length) out.push(`<p>${inline(para.join(' '))}</p>`);
      para = [];
    };
    const closeList = () => {
      if (list) out.push(`</${list}>`);
      list = null;
    };
    const openList = (type) => {
      if (list !== type) {
        closeList();
        out.push(`<${type}>`);
        list = type;
      }
    };

    for (const raw of lines) {
      const line = raw.trimEnd();
      let m;
      if (!line.trim()) {
        flushPara();
        closeList();
      } else if ((m = /^(#{1,4})\s+(.*)$/.exec(line))) {
        flushPara();
        closeList();
        const level = Math.min(4, m[1].length + 1);
        out.push(`<h${level}>${inline(m[2])}</h${level}>`);
      } else if ((m = /^\s*[-*]\s+\[([ xX])\]\s+(.*)$/.exec(line))) {
        flushPara();
        openList('ul');
        const done = m[1].toLowerCase() === 'x';
        out.push(`<li class="task${done ? ' done' : ''}"><span class="box">${done ? '✓' : ''}</span>${inline(m[2])}</li>`);
      } else if ((m = /^\s*[-*•]\s+(.*)$/.exec(line))) {
        flushPara();
        openList('ul');
        out.push(`<li>${inline(m[1])}</li>`);
      } else if ((m = /^\s*\d+[.)]\s+(.*)$/.exec(line))) {
        flushPara();
        openList('ol');
        out.push(`<li>${inline(m[1])}</li>`);
      } else {
        closeList();
        para.push(line.trim());
      }
    }
    flushPara();
    closeList();
    return out.join('\n');
  }

  // Works in the page (window.renderMarkdown) and in Node (export builder in the main process).
  if (typeof module !== 'undefined' && module.exports) module.exports = { renderMarkdown: render, escapeHtml: esc };
  else {
    window.renderMarkdown = render;
    window.escapeHtml = esc;
  }
})();
