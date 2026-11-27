import { Fragment, type ReactNode, useMemo, useState } from 'react';
import { Check, Code2, Copy, Download, Eye, ZoomIn, ZoomOut } from 'lucide-react';
import { inflateRaw } from 'pako';
import { cn } from './utils';

type Block =
  | { type: 'md'; text: string }
  | { type: 'code'; lang: string; code: string }
  | { type: 'svg'; xml: string }
  | { type: 'drawio'; xml: string };

const SAFE_URL = /^(https?:|mailto:)/i;
const SAFE_IMG = /^(https?:\/\/|data:image\/(?:png|jpeg|gif|webp);base64,)/i;

function isDrawioXml(s: string) {
  return /<(?:mxfile|mxGraphModel)\b/i.test(s);
}

/** Splits raw message text into Markdown, fenced code, inline SVG, and Draw.io blocks. */
function splitBlocks(input: string): Block[] {
  const blocks: Block[] = [];
  const fenceRe = /```([^\r\n`]*)\r?\n([\s\S]*?)```/g;
  let last = 0;
  for (const m of input.matchAll(fenceRe)) {
    const idx = m.index ?? 0;
    if (idx > last) pushInlineMarkupBlocks(input.slice(last, idx), blocks);
    const lang = m[1].trim().toLowerCase();
    const code = m[2].replace(/\r?\n$/, '');
    if (lang === 'svg' || (lang === 'xml' && /^\s*<svg\b/i.test(code))) {
      blocks.push({ type: 'svg', xml: code });
    } else if (lang === 'drawio' || lang === 'mxfile' || ((lang === 'xml' || lang === '') && isDrawioXml(code))) {
      blocks.push({ type: 'drawio', xml: code });
    } else {
      blocks.push({ type: 'code', lang, code });
    }
    last = idx + m[0].length;
  }
  if (last < input.length) pushInlineMarkupBlocks(input.slice(last), blocks);
  return blocks;
}

/** Extracts raw <svg>...</svg>, <mxfile>...</mxfile>, or <mxGraphModel>...</mxGraphModel> outside code fences. */
function pushInlineMarkupBlocks(text: string, out: Block[]) {
  const tagRe = /(<svg\b[\s\S]*?<\/svg>|<mxfile\b[\s\S]*?<\/mxfile>|<mxGraphModel\b[\s\S]*?<\/mxGraphModel>)/gi;
  let last = 0;
  for (const m of text.matchAll(tagRe)) {
    const idx = m.index ?? 0;
    if (idx > last) out.push({ type: 'md', text: text.slice(last, idx) });
    const raw = m[1];
    out.push({ type: /^<svg\b/i.test(raw) ? 'svg' : 'drawio', xml: raw });
    last = idx + raw.length;
  }
  if (last < text.length) out.push({ type: 'md', text: text.slice(last) });
}

function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
      className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-2xs text-muted-foreground hover:bg-surface-3 hover:text-foreground"
      aria-label={copied ? 'Copied' : label}
    >
      {copied ? <Check className="size-3 text-success" /> : <Copy className="size-3" />}
      <span>{copied ? 'Copied' : label}</span>
    </button>
  );
}

function downloadText(filename: string, content: string, mime: string) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function CodeBlock({ lang, code }: { lang: string; code: string }) {
  return (
    <div className="my-2 overflow-hidden rounded-lg border bg-canvas text-xs">
      <div className="flex items-center justify-between border-b bg-surface-2 px-3 py-1 text-2xs text-muted-foreground">
        <span className="font-mono">{lang || 'text'}</span>
        <CopyButton text={code} />
      </div>
      <pre className="scrollbar-thin overflow-x-auto p-3 font-mono text-xs leading-relaxed">
        <code>{code}</code>
      </pre>
    </div>
  );
}

function sanitizeSvg(raw: string): string | null {
  try {
    const doc = new DOMParser().parseFromString(raw, 'image/svg+xml');
    if (doc.querySelector('parsererror')) return null;
    const svg = doc.documentElement;
    if (!svg || svg.tagName.toLowerCase() !== 'svg') return null;
    for (const bad of svg.querySelectorAll('script, iframe, object, embed, foreignObject')) bad.remove();
    for (const el of [svg, ...svg.querySelectorAll('*')]) {
      for (const attr of [...el.attributes]) {
        const name = attr.name.toLowerCase();
        const val = attr.value.trim();
        if (name.startsWith('on')) el.removeAttribute(attr.name);
        else if ((name === 'href' || name === 'xlink:href') && /^(?:javascript:|data:text\/html)/i.test(val)) {
          el.removeAttribute(attr.name);
        }
      }
    }
    svg.setAttribute('class', 'max-w-full h-auto');
    if (!svg.getAttribute('style')) svg.setAttribute('style', 'max-height: 28rem; width: auto;');
    return new XMLSerializer().serializeToString(svg);
  } catch {
    return null;
  }
}

function SvgBlock({ xml }: { xml: string }) {
  const [showSource, setShowSource] = useState(false);
  const safe = useMemo(() => sanitizeSvg(xml), [xml]);
  if (!safe) return <CodeBlock lang="svg" code={xml} />;
  return (
    <div className="my-2 overflow-hidden rounded-lg border bg-surface">
      <div className="flex items-center justify-between gap-2 border-b bg-surface-2 px-3 py-1 text-2xs text-muted-foreground">
        <span className="font-medium">SVG diagram</span>
        <div className="flex items-center gap-1">
          <button type="button" onClick={() => setShowSource(s => !s)} className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-surface-3 hover:text-foreground">
            {showSource ? <Eye className="size-3" /> : <Code2 className="size-3" />}
            <span>{showSource ? 'Preview' : 'Source'}</span>
          </button>
          <CopyButton text={xml} />
          <button type="button" onClick={() => downloadText('diagram.svg', xml, 'image/svg+xml')} className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-surface-3 hover:text-foreground" aria-label="Download SVG">
            <Download className="size-3" />
          </button>
        </div>
      </div>
      {showSource ? (
        <pre className="scrollbar-thin overflow-x-auto bg-canvas p-3 font-mono text-xs leading-relaxed"><code>{xml}</code></pre>
      ) : (
        <div className="scrollbar-thin flex max-h-[30rem] items-center justify-center overflow-auto bg-white p-3 dark:bg-neutral-900" dangerouslySetInnerHTML={{ __html: safe }} />
      )}
    </div>
  );
}

type MxNode = {
  id: string;
  label: string;
  x: number;
  y: number;
  w: number;
  h: number;
  style: Record<string, string>;
  flags: Set<string>;
};
type MxEdge = {
  id: string;
  label: string;
  source?: string;
  target?: string;
  points: { x: number; y: number }[];
  style: Record<string, string>;
};

function parseStyle(raw: string | null): { map: Record<string, string>; flags: Set<string> } {
  const map: Record<string, string> = {};
  const flags = new Set<string>();
  for (const part of (raw ?? '').split(';')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) flags.add(trimmed);
    else map[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
  }
  return { map, flags };
}

function stripHtmlTags(s: string): string {
  return s.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
}

function decodeDiagramPayload(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.startsWith('<')) return trimmed || null;
  try {
    const bin = atob(trimmed);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const inflated = inflateRaw(bytes, { to: 'string' });
    return decodeURIComponent(inflated);
  } catch {
    return null;
  }
}

function parseDrawio(xml: string): { nodes: MxNode[]; edges: MxEdge[]; width: number; height: number; minX: number; minY: number } | null {
  try {
    const doc = new DOMParser().parseFromString(xml, 'text/xml');
    if (doc.querySelector('parsererror')) return null;
    let model: Element | null = doc.querySelector('mxGraphModel');
    if (!model) {
      const diagram = doc.querySelector('diagram');
      const inner = diagram?.textContent ? decodeDiagramPayload(diagram.textContent) : null;
      if (!inner) return null;
      const innerDoc = new DOMParser().parseFromString(inner, 'text/xml');
      model = innerDoc.querySelector('mxGraphModel');
    }
    if (!model) return null;

    const rawNodes = new Map<string, MxNode>();
    const rawEdges: { id: string; label: string; source?: string; target?: string; pts: { x: number; y: number }[]; style: Record<string, string>; parent: string }[] = [];
    const parents = new Map<string, string>();

    for (const cell of model.querySelectorAll('mxCell')) {
      const id = cell.getAttribute('id') ?? '';
      const parent = cell.getAttribute('parent') ?? '1';
      if (id) parents.set(id, parent);
      const geom = cell.querySelector('mxGeometry');
      const { map, flags } = parseStyle(cell.getAttribute('style'));
      const label = stripHtmlTags(cell.getAttribute('value') ?? '');
      if (cell.getAttribute('vertex') === '1' && geom) {
        const x = Number(geom.getAttribute('x') ?? 0);
        const y = Number(geom.getAttribute('y') ?? 0);
        const w = Number(geom.getAttribute('width') ?? 120) || 120;
        const h = Number(geom.getAttribute('height') ?? 48) || 48;
        rawNodes.set(id, { id, label, x, y, w, h, style: map, flags });
      } else if (cell.getAttribute('edge') === '1') {
        const pts: { x: number; y: number }[] = [];
        const srcPt = geom?.querySelector('mxPoint[as="sourcePoint"]');
        if (srcPt) pts.push({ x: Number(srcPt.getAttribute('x') ?? 0), y: Number(srcPt.getAttribute('y') ?? 0) });
        for (const pt of geom?.querySelectorAll('Array[as="points"] > mxPoint') ?? []) {
          pts.push({ x: Number(pt.getAttribute('x') ?? 0), y: Number(pt.getAttribute('y') ?? 0) });
        }
        const tgtPt = geom?.querySelector('mxPoint[as="targetPoint"]');
        if (tgtPt) pts.push({ x: Number(tgtPt.getAttribute('x') ?? 0), y: Number(tgtPt.getAttribute('y') ?? 0) });
        rawEdges.push({ id, label, source: cell.getAttribute('source') ?? undefined, target: cell.getAttribute('target') ?? undefined, pts, style: map, parent });
      }
    }

    // Resolve nested parent offsets so child vertices inside swimlanes/groups sit in global coordinates.
    const absPos = new Map<string, { x: number; y: number }>();
    const resolve = (id: string, seen = new Set<string>()): { x: number; y: number } => {
      if (absPos.has(id)) return absPos.get(id)!;
      const node = rawNodes.get(id);
      if (!node || seen.has(id)) return { x: 0, y: 0 };
      seen.add(id);
      const p = parents.get(id);
      const pPos = p && rawNodes.has(p) ? resolve(p, seen) : { x: 0, y: 0 };
      const pos = { x: node.x + pPos.x, y: node.y + pPos.y };
      absPos.set(id, pos);
      return pos;
    };
    for (const [id, node] of rawNodes) {
      const pos = resolve(id);
      node.x = pos.x;
      node.y = pos.y;
    }

    const nodes = [...rawNodes.values()];
    const edges: MxEdge[] = rawEdges.map(e => {
      const s = e.source ? rawNodes.get(e.source) : undefined;
      const t = e.target ? rawNodes.get(e.target) : undefined;
      const points: { x: number; y: number }[] = [];
      if (s) points.push({ x: s.x + s.w / 2, y: s.y + s.h / 2 });
      const pOff = rawNodes.has(e.parent) ? resolve(e.parent) : { x: 0, y: 0 };
      for (const p of e.pts) points.push({ x: p.x + pOff.x, y: p.y + pOff.y });
      if (t) points.push({ x: t.x + t.w / 2, y: t.y + t.h / 2 });
      return { id: e.id, label: e.label, source: e.source, target: e.target, points, style: e.style };
    }).filter(e => e.points.length >= 2);

    if (!nodes.length && !edges.length) return null;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of nodes) {
      minX = Math.min(minX, n.x);
      minY = Math.min(minY, n.y);
      maxX = Math.max(maxX, n.x + n.w);
      maxY = Math.max(maxY, n.y + n.h);
    }
    for (const e of edges) {
      for (const p of e.points) {
        minX = Math.min(minX, p.x);
        minY = Math.min(minY, p.y);
        maxX = Math.max(maxX, p.x);
        maxY = Math.max(maxY, p.y);
      }
    }
    const pad = 24;
    minX -= pad; minY -= pad; maxX += pad; maxY += pad;
    return { nodes, edges, minX, minY, width: Math.max(120, maxX - minX), height: Math.max(80, maxY - minY) };
  } catch {
    return null;
  }
}

function DrawioBlock({ xml }: { xml: string }) {
  const [showSource, setShowSource] = useState(false);
  const [zoom, setZoom] = useState(1);
  const parsed = useMemo(() => parseDrawio(xml), [xml]);
  if (!parsed) return <CodeBlock lang="drawio" code={xml} />;

  return (
    <div className="my-2 overflow-hidden rounded-lg border bg-surface">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b bg-surface-2 px-3 py-1 text-2xs text-muted-foreground">
        <span className="font-medium">Draw.io diagram ({parsed.nodes.length} nodes)</span>
        <div className="flex items-center gap-1">
          {!showSource && <>
            <button type="button" onClick={() => setZoom(z => Math.max(0.5, +(z - 0.25).toFixed(2)))} className="rounded p-0.5 hover:bg-surface-3 hover:text-foreground" aria-label="Zoom out"><ZoomOut className="size-3" /></button>
            <span className="min-w-8 text-center tabular-nums">{Math.round(zoom * 100)}%</span>
            <button type="button" onClick={() => setZoom(z => Math.min(2.5, +(z + 0.25).toFixed(2)))} className="rounded p-0.5 hover:bg-surface-3 hover:text-foreground" aria-label="Zoom in"><ZoomIn className="size-3" /></button>
          </>}
          <button type="button" onClick={() => setShowSource(s => !s)} className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-surface-3 hover:text-foreground">
            {showSource ? <Eye className="size-3" /> : <Code2 className="size-3" />}
            <span>{showSource ? 'Preview' : 'Source'}</span>
          </button>
          <CopyButton text={xml} label="Copy XML" />
          <button type="button" onClick={() => downloadText('diagram.drawio', xml, 'application/xml')} className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-surface-3 hover:text-foreground" aria-label="Download .drawio">
            <Download className="size-3" />
          </button>
        </div>
      </div>
      {showSource ? (
        <pre className="scrollbar-thin overflow-x-auto bg-canvas p-3 font-mono text-xs leading-relaxed"><code>{xml}</code></pre>
      ) : (
        <div className="scrollbar-thin max-h-[30rem] overflow-auto bg-white p-3 dark:bg-neutral-900">
          <svg
            viewBox={`${parsed.minX} ${parsed.minY} ${parsed.width} ${parsed.height}`}
            style={{ width: `${Math.round(parsed.width * zoom)}px`, maxWidth: zoom <= 1 ? '100%' : 'none', height: 'auto' }}
            className="mx-auto block"
            role="img"
            aria-label="Draw.io diagram"
          >
            <defs>
              <marker id="mx-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                <path d="M 0 1 L 10 5 L 0 9 z" fill="#64748b" />
              </marker>
            </defs>
            {parsed.edges.map(e => {
              const pts = e.points.map(p => `${p.x},${p.y}`).join(' ');
              const stroke = e.style.strokeColor && e.style.strokeColor !== 'none' ? e.style.strokeColor : '#64748b';
              const dashed = e.style.dashed === '1' ? '5 4' : undefined;
              const mid = e.points[Math.floor(e.points.length / 2)];
              return (
                <g key={e.id}>
                  <polyline points={pts} fill="none" stroke={stroke} strokeWidth={1.5} strokeDasharray={dashed} markerEnd={e.style.endArrow === 'none' ? undefined : 'url(#mx-arrow)'} />
                  {e.label && <text x={mid.x} y={mid.y - 4} textAnchor="middle" fontSize="11" fill="#475569" className="font-sans">{e.label}</text>}
                </g>
              );
            })}
            {parsed.nodes.map(n => {
              const fill = n.style.fillColor === 'none' ? 'transparent' : n.style.fillColor || '#f8fafc';
              const stroke = n.style.strokeColor === 'none' ? 'transparent' : n.style.strokeColor || '#94a3b8';
              const textColor = n.style.fontColor || '#0f172a';
              const isEllipse = n.flags.has('ellipse') || n.style.shape === 'ellipse';
              const isRhombus = n.flags.has('rhombus') || n.style.shape === 'rhombus';
              const rounded = n.style.rounded === '1' ? 8 : 2;
              const lines = n.label ? n.label.split('\n') : [];
              const cx = n.x + n.w / 2;
              const cy = n.y + n.h / 2;
              return (
                <g key={n.id}>
                  {isEllipse ? (
                    <ellipse cx={cx} cy={cy} rx={n.w / 2} ry={n.h / 2} fill={fill} stroke={stroke} strokeWidth={1.5} />
                  ) : isRhombus ? (
                    <polygon points={`${cx},${n.y} ${n.x + n.w},${cy} ${cx},${n.y + n.h} ${n.x},${cy}`} fill={fill} stroke={stroke} strokeWidth={1.5} />
                  ) : (
                    <rect x={n.x} y={n.y} width={n.w} height={n.h} rx={rounded} ry={rounded} fill={fill} stroke={stroke} strokeWidth={1.5} />
                  )}
                  {lines.length > 0 && (
                    <text x={cx} y={cy - ((lines.length - 1) * 7)} textAnchor="middle" dominantBaseline="central" fontSize="12" fill={textColor} className="font-sans">
                      {lines.map((line, i) => <tspan key={i} x={cx} dy={i === 0 ? 0 : 14}>{line}</tspan>)}
                    </text>
                  )}
                </g>
              );
            })}
          </svg>
        </div>
      )}
    </div>
  );
}

/** Parses inline Markdown: code, images, links, bold/italic/strike, and bare URLs. */
function renderInline(text: string): ReactNode[] {
  const tokens: ReactNode[] = [];
  const re = /(`[^`\n]+`|!\[[^\]]*\]\([^)]+\)|\[[^\]]+\]\([^)]+\)|\*\*\*[^*\n]+\*\*\*|\*\*[^*\n]+\*\*|__[^_\n]+__|~~[^~\n]+~~|\*[^*\n]+\*|_[^_\n]+_|https?:\/\/[^\s<>)"]+)/g;
  let last = 0;
  let k = 0;
  for (const m of text.matchAll(re)) {
    const idx = m.index ?? 0;
    if (idx > last) tokens.push(text.slice(last, idx));
    const tok = m[0];
    if (tok.startsWith('`')) {
      tokens.push(<code key={k++} className="rounded bg-surface-3 px-1 py-0.5 font-mono text-[0.85em]">{tok.slice(1, -1)}</code>);
    } else if (tok.startsWith('![')) {
      const p = tok.match(/^!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)$/);
      if (p && SAFE_IMG.test(p[2])) {
        tokens.push(<img key={k++} src={p[2]} alt={p[1]} loading="lazy" className="my-1.5 max-h-80 max-w-full rounded-lg border object-contain" />);
      } else tokens.push(tok);
    } else if (tok.startsWith('[')) {
      const p = tok.match(/^\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)$/);
      if (p && SAFE_URL.test(p[2])) {
        tokens.push(<a key={k++} href={p[2]} target="_blank" rel="noreferrer" className="text-signal underline underline-offset-2 hover:opacity-80">{renderInline(p[1])}</a>);
      } else tokens.push(tok);
    } else if (tok.startsWith('***')) {
      tokens.push(<strong key={k++}><em>{renderInline(tok.slice(3, -3))}</em></strong>);
    } else if (tok.startsWith('**') || tok.startsWith('__')) {
      tokens.push(<strong key={k++} className="font-semibold">{renderInline(tok.slice(2, -2))}</strong>);
    } else if (tok.startsWith('~~')) {
      tokens.push(<del key={k++} className="text-muted-foreground">{renderInline(tok.slice(2, -2))}</del>);
    } else if (tok.startsWith('*') || tok.startsWith('_')) {
      tokens.push(<em key={k++}>{renderInline(tok.slice(1, -1))}</em>);
    } else if (/^https?:\/\//i.test(tok)) {
      const clean = tok.replace(/[.,;:!?]+$/, '');
      const trail = tok.slice(clean.length);
      tokens.push(<Fragment key={k++}><a href={clean} target="_blank" rel="noreferrer" className="text-signal underline underline-offset-2 hover:opacity-80">{clean}</a>{trail}</Fragment>);
    } else {
      tokens.push(tok);
    }
    last = idx + tok.length;
  }
  if (last < text.length) tokens.push(text.slice(last));
  return tokens;
}

function splitTableRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return trimmed.split('|').map(c => c.trim());
}

function isTableSep(line: string): boolean {
  const cells = splitTableRow(line);
  return cells.length > 0 && cells.every(c => /^:?-{3,}:?$/.test(c));
}

function MarkdownBlock({ text }: { text: string }) {
  const lines = text.split(/\r?\n/);
  const out: ReactNode[] = [];
  let i = 0;
  let k = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }

    // Heading
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      const level = h[1].length;
      const cls = level === 1 ? 'text-base font-semibold mt-2 mb-1' : level === 2 ? 'text-sm font-semibold mt-2 mb-1' : 'text-sm font-medium mt-1.5 mb-0.5';
      out.push(<p key={k++} className={cls}>{renderInline(h[2])}</p>);
      i++; continue;
    }

    // Horizontal rule
    if (/^\s*(?:---+|\*\*\*+|___+)\s*$/.test(line)) {
      out.push(<hr key={k++} className="my-2 border-border" />);
      i++; continue;
    }

    // Table
    if (line.includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      const headers = splitTableRow(line);
      const aligns = splitTableRow(lines[i + 1]).map(c => c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : 'left');
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
        rows.push(splitTableRow(lines[i]));
        i++;
      }
      out.push(
        <div key={k++} className="scrollbar-thin my-2 overflow-x-auto rounded-lg border">
          <table className="w-full border-collapse text-left text-xs">
            <thead className="bg-surface-2 text-muted-foreground">
              <tr>{headers.map((cell, ci) => <th key={ci} style={{ textAlign: aligns[ci] as any }} className="border-b px-2.5 py-1.5 font-medium">{renderInline(cell)}</th>)}</tr>
            </thead>
            <tbody>
              {rows.map((row, ri) => (
                <tr key={ri} className="border-b last:border-0">
                  {headers.map((_, ci) => <td key={ci} style={{ textAlign: aligns[ci] as any }} className="px-2.5 py-1.5">{renderInline(row[ci] ?? '')}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
      continue;
    }

    // Blockquote
    if (/^\s*>\s?/.test(line)) {
      const quoteLines: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        quoteLines.push(lines[i].replace(/^\s*>\s?/, ''));
        i++;
      }
      out.push(<blockquote key={k++} className="my-1.5 border-l-2 border-border-strong pl-3 text-muted-foreground">{renderInline(quoteLines.join('\n'))}</blockquote>);
      continue;
    }

    // Unordered / task list
    if (/^\s*[-*+]\s+/.test(line)) {
      const items: { checked: boolean | null; text: string }[] = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
        const raw = lines[i].replace(/^\s*[-*+]\s+/, '');
        const task = raw.match(/^\[([ xX])\]\s+(.*)$/);
        items.push(task ? { checked: task[1].toLowerCase() === 'x', text: task[2] } : { checked: null, text: raw });
        i++;
      }
      out.push(
        <ul key={k++} className="my-1 list-disc space-y-0.5 pl-5">
          {items.map((it, idx) => (
            <li key={idx} className={cn(it.checked !== null && 'list-none -ml-4 flex items-start gap-1.5')}>
              {it.checked !== null && <input type="checkbox" checked={it.checked} readOnly aria-label="Task status" className="mt-1 size-3.5 accent-signal" />}
              <span>{renderInline(it.text)}</span>
            </li>
          ))}
        </ul>
      );
      continue;
    }

    // Ordered list
    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+\.\s+/, ''));
        i++;
      }
      out.push(<ol key={k++} className="my-1 list-decimal space-y-0.5 pl-5">{items.map((it, idx) => <li key={idx}>{renderInline(it)}</li>)}</ol>);
      continue;
    }

    // Paragraph (collect consecutive plain lines)
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^(#{1,6}\s+|>\s?|[-*+]\s+|\d+\.\s+|(?:---+|\*\*\*+|___+)\s*$)/.test(lines[i].trim()) &&
      !(lines[i].includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1]))
    ) {
      para.push(lines[i]);
      i++;
    }
    out.push(<p key={k++} className="my-1 whitespace-pre-wrap break-words [overflow-wrap:anywhere] leading-relaxed">{renderInline(para.join('\n'))}</p>);
  }

  return <>{out}</>;
}

/** Renders chat/mail body inline with Markdown, code blocks, sanitized SVGs, and Draw.io diagrams. */
export function RichMessage({ text }: { text: string }) {
  const blocks = useMemo(() => splitBlocks(text), [text]);
  return (
    <div className="min-w-0 space-y-1 text-sm [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
      {blocks.map((b, i) => {
        if (b.type === 'code') return <CodeBlock key={i} lang={b.lang} code={b.code} />;
        if (b.type === 'svg') return <SvgBlock key={i} xml={b.xml} />;
        if (b.type === 'drawio') return <DrawioBlock key={i} xml={b.xml} />;
        return <MarkdownBlock key={i} text={b.text} />;
      })}
    </div>
  );
}
