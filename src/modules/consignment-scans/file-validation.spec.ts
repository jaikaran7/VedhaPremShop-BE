import { checkUpload, DOCX, officeText, XLSX } from './file-validation';

/** A minimal stored (uncompressed) ZIP, enough for the validator's central-directory reader. */
function zip(files: Record<string, string>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const data = Buffer.from(text);
    const nameBuf = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, data);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const dir = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, dir, end]);
}

/** The first bytes of a WEBP photo are all the validator looks at. */
const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 '), Buffer.alloc(32)]);

describe('checkUpload', () => {
  it('accepts a WEBP photo by its bytes', () => {
    expect(checkUpload(webp, 'image/webp')).toEqual({ ok: true, type: 'image/webp' });
  });

  it('rejects a declared type that does not match the bytes', () => {
    expect(checkUpload(webp, 'image/png')).toMatchObject({ ok: false });
  });

  it('rejects scripts, executables and empty files whatever they claim to be', () => {
    expect(checkUpload(Buffer.from('#!/bin/sh\nrm -rf /\n'), 'image/jpeg')).toMatchObject({ ok: false });
    expect(checkUpload(Buffer.from('MZ\x90\x00\x03\x00\x00\x00\x04\x00\x00\x00'), 'application/pdf')).toMatchObject({ ok: false });
    expect(checkUpload(Buffer.alloc(0), 'image/png')).toMatchObject({ ok: false });
  });

  it('accepts a PDF but not one carrying JavaScript', () => {
    expect(checkUpload(Buffer.from('%PDF-1.7\n1 0 obj << >> endobj\n%%EOF'), 'application/pdf')).toEqual({ ok: true, type: 'application/pdf' });
    expect(checkUpload(Buffer.from('%PDF-1.7\n1 0 obj << /S /JavaScript /JS (app.alert(1)) >>\n%%EOF'), 'application/pdf')).toMatchObject({ ok: false });
  });

  it('tells DOCX from XLSX and rejects macro-enabled packages and plain zips', () => {
    const types = '<Types><Override ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>';
    expect(checkUpload(zip({ '[Content_Types].xml': types, 'word/document.xml': '<w:p>x</w:p>' }), DOCX)).toEqual({ ok: true, type: DOCX });
    expect(checkUpload(zip({ '[Content_Types].xml': '<Types/>', 'xl/workbook.xml': '<workbook/>' }), XLSX)).toEqual({ ok: true, type: XLSX });
    expect(checkUpload(zip({ '[Content_Types].xml': '<Types/>', 'xl/workbook.xml': '<w/>', 'xl/vbaProject.bin': 'x' }), XLSX)).toMatchObject({ ok: false, reason: expect.stringContaining('Macro') });
    expect(checkUpload(zip({ '[Content_Types].xml': 'application/vnd.ms-word.document.macroEnabled.main+xml', 'word/document.xml': '<w/>' }), DOCX)).toMatchObject({ ok: false });
    expect(checkUpload(zip({ 'evil.js': 'alert(1)' }), XLSX)).toMatchObject({ ok: false });
  });
});

describe('officeText', () => {
  it('reads XLSX rows with shared strings as tab-separated text', () => {
    const book = zip({
      'xl/workbook.xml': '<workbook/>',
      'xl/sharedStrings.xml': '<sst><si><t>ONION</t></si><si><t>M&amp;S</t></si></sst>',
      'xl/worksheets/sheet1.xml': '<sheetData><row r="1"><c t="s"><v>0</v></c><c><v>42</v></c><c><v>1986</v></c></row><row r="2"><c t="s"><v>1</v></c></row></sheetData>',
    });
    expect(officeText(book, XLSX)).toBe('# sheet1.xml\nONION\t42\t1986\nM&S');
  });

  it('reads DOCX paragraphs as lines', () => {
    const doc = zip({ 'word/document.xml': '<w:body><w:p><w:r><w:t>Bill 00045</w:t></w:r></w:p><w:p><w:r><w:t>42</w:t><w:tab/><w:t>465</w:t></w:r></w:p></w:body>' });
    expect(officeText(doc, DOCX)).toBe('Bill 00045\n42\t465');
  });
});
