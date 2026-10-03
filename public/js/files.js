// 多文件解析：一次上传多个文件，统一转成纯文本。
// 文本类直接读取；Word 用 mammoth，PDF 用 pdf.js，都在第一次用到时才从 CDN 加载。
(function (root) {
  const TEXT_EXT = ['md', 'markdown', 'txt', 'csv', 'tsv', 'json', 'html', 'htm', 'yaml', 'yml'];
  const ACCEPT = [...TEXT_EXT, 'docx', 'pdf'].map(e => '.' + e).join(',');
  const MAX_CHARS = 20000; // 单个文件送给 AI 的最大字数

  const MAMMOTH = 'https://cdn.jsdelivr.net/npm/mammoth@1.8.0/mammoth.browser.min.js';
  const PDFJS = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.min.js';
  const PDF_WORKER = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js';
  const PDF_CMAPS = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/cmaps/'; // 中文 PDF 常用的字符映射表

  const loaded = {};
  function loadScript(src) {
    if (!loaded[src]) {
      loaded[src] = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        const timer = setTimeout(() => { delete loaded[src]; reject(new Error('解析组件加载超时（需要联网）。可以改传 Markdown 或 TXT，或把内容粘贴到补充说明')); }, 15000);
        s.src = src; s.onload = () => { clearTimeout(timer); resolve(); };
        s.onerror = () => { clearTimeout(timer); delete loaded[src]; reject(new Error('解析组件加载失败（需要联网）。可以改传 Markdown 或 TXT，或把内容粘贴到补充说明')); };
        document.head.appendChild(s);
      });
    }
    return loaded[src];
  }

  const ext = name => (name.split('.').pop() || '').toLowerCase();
  const readText = f => f.text();

  async function readDocx(f) {
    await loadScript(MAMMOTH);
    const r = await root.mammoth.extractRawText({ arrayBuffer: await f.arrayBuffer() });
    return r.value;
  }

  async function readPdf(f) {
    await loadScript(PDFJS);
    const lib = root.pdfjsLib;
    lib.GlobalWorkerOptions.workerSrc = PDF_WORKER;
    const pdf = await lib.getDocument({ data: new Uint8Array(await f.arrayBuffer()), cMapUrl: PDF_CMAPS, cMapPacked: true, verbosity: 0 }).promise;
    const pages = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const c = await (await pdf.getPage(i)).getTextContent();
      pages.push(c.items.map(it => it.str + (it.hasEOL ? '\n' : '')).join(''));
    }
    return pages.join('\n');
  }

  // 返回 [{name, text, ok, error, truncated}]
  async function parseFiles(fileList) {
    const out = [];
    for (const f of Array.from(fileList)) {
      const e = ext(f.name);
      try {
        let text;
        if (TEXT_EXT.includes(e)) text = await readText(f);
        else if (e === 'docx') text = await readDocx(f);
        else if (e === 'pdf') text = await readPdf(f);
        else throw new Error('暂不支持这种格式');
        text = (text || '').replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
        if (!text) throw new Error('没有读到文字内容（可能是扫描件或图片）');
        const truncated = text.length > MAX_CHARS;
        out.push({ name: f.name, text: truncated ? text.slice(0, MAX_CHARS) : text, ok: true, truncated, chars: text.length });
      } catch (err) {
        out.push({ name: f.name, text: '', ok: false, error: err.message });
      }
    }
    return out;
  }

  root.Files = { parseFiles, ACCEPT, TEXT_EXT };
})(window);
