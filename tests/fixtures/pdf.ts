// Tiny PDFs built in the test (docs/specs/SINGLE_FILE_FORMATS.md, PDF): a
// page or a few with lines of Helvetica text, optional link annotations and an
// optional document-level JavaScript action. Nothing from the internet: every
// byte is written here, with a correct cross-reference table.

export type PdfFixture = {
  /** One array of lines per page. */
  pages: string[][];
  /** URI link annotations on the first page. */
  links?: string[];
  /** A /JavaScript OpenAction (must never run anywhere). */
  javascript?: string;
  title?: string;
};

const literal = (text: string) => `(${text.replace(/[\\()]/g, (ch) => `\\${ch}`)})`;

export function buildPdf(fixture: PdfFixture): Buffer {
  const objects: string[] = [];
  const add = (body: string) => {
    objects.push(body);
    return objects.length;
  };
  // Fixed numbers for the tree: 1 catalog, 2 pages, 3 font.
  add("CATALOG");
  add("PAGES");
  add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
  const pageIds: number[] = [];
  fixture.pages.forEach((lines, index) => {
    const content = [
      "BT",
      "/F1 14 Tf",
      "18 TL",
      "56 780 Td",
      ...lines.map((line) => `${literal(line)} Tj T*`),
      "ET",
    ].join("\n");
    const stream = add(`<< /Length ${Buffer.byteLength(content, "latin1")} >>\nstream\n${content}\nendstream`);
    const annots =
      index === 0 && fixture.links?.length
        ? fixture.links.map((uri, at) =>
            add(
              `<< /Type /Annot /Subtype /Link /Rect [56 ${700 - at * 20} 300 ${716 - at * 20}] /Border [0 0 0] /A << /S /URI /URI ${literal(uri)} >> >>`,
            ),
          )
        : [];
    pageIds.push(
      add(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ${stream} 0 R${
          annots.length ? ` /Annots [${annots.map((id) => `${id} 0 R`).join(" ")}]` : ""
        } >>`,
      ),
    );
  });
  const action = fixture.javascript ? add(`<< /Type /Action /S /JavaScript /JS ${literal(fixture.javascript)} >>`) : 0;
  const info = fixture.title ? add(`<< /Title ${literal(fixture.title)} >>`) : 0;
  objects[0] = `<< /Type /Catalog /Pages 2 0 R${action ? ` /OpenAction ${action} 0 R` : ""} >>`;
  objects[1] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageIds.length} >>`;
  let out = "%PDF-1.7\n%\xe2\xe3\xcf\xd3\n";
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(Buffer.byteLength(out, "latin1"));
    out += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, "latin1");
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) out += `${String(offset).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R${info ? ` /Info ${info} 0 R` : ""} >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}
