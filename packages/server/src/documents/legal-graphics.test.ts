import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'

import { PDFDocument } from '@cantoo/pdf-lib'
import { shippedWordings } from '@opengewerk/domain'
import { describe, expect, it } from 'vitest'

import { durabilityLabelSvg } from './durability-label.js'
import {
  durabilityLabelDrawing,
  filledDurabilityLabel,
  isLegalGraphic,
  LegalGraphicError,
  legalGraphicImage,
  legalGraphics,
  legalPage,
  withLegalPages,
} from './legal-graphics.js'

const notice = 'guarantee-notice-de-2025-09-25'

/** A4 in points, the size of the Commission's page. */
const a4 = { width: 595.276, height: 841.89 }

/** A PDF as the renderer returns it, with pages of a size no notice has. */
async function renderedWith(pages: number): Promise<Uint8Array> {
  const document = await PDFDocument.create()

  for (let index = 0; index < pages; index += 1) {
    document.addPage([500, 700])
  }

  return document.save()
}

describe('the pages the law prescribes whole', () => {
  it('ship with every wording that names one', () => {
    const named = shippedWordings.flatMap((wording) =>
      wording.graphic === undefined ? [] : [wording.graphic],
    )

    expect(named).toEqual([notice])
    expect(named.every(isLegalGraphic)).toBe(true)
  })

  it('carry the digests their README names', async () => {
    const readme = await readFile(new URL('../../assets/legal/README.md', import.meta.url), 'utf-8')

    for (const graphic of Object.values(legalGraphics)) {
      expect(readme).toContain(graphic.pdf.sha256)
      expect(readme).toContain(graphic.image.sha256)
    }
  })

  it('are the page of the Commission, in A4, and its picture', async () => {
    const image = await legalGraphicImage(notice)
    const sheet = await PDFDocument.load(await legalPage(notice))
    const size = sheet.getPage(0).getSize()

    expect(image.mediaType).toBe('image/png')
    expect([...image.bytes.slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47])
    expect(sheet.getPageCount()).toBe(1)
    expect(size.width).toBeCloseTo(a4.width, 1)
    expect(size.height).toBeCloseTo(a4.height, 1)
  })

  it('take the place of the empty last page, and leave every other one', async () => {
    const pdf = await PDFDocument.load(await withLegalPages(await renderedWith(3), [notice]))

    expect(pdf.getPageCount()).toBe(3)
    expect(pdf.getPage(0).getSize()).toEqual({ width: 500, height: 700 })
    expect(pdf.getPage(1).getSize()).toEqual({ width: 500, height: 700 })
    expect(pdf.getPage(2).getSize().width).toBeCloseTo(a4.width, 1)
    expect(pdf.getPage(2).getSize().height).toBeCloseTo(a4.height, 1)
  })

  it('leave a document without them as it was', async () => {
    const rendered = await renderedWith(2)

    expect(await withLegalPages(rendered, [])).toBe(rendered)
  })

  it('refuse a name this version does not ship, and a PDF without room for them', async () => {
    await expect(legalPage('guarantee-notice-xx')).rejects.toThrow(LegalGraphicError)
    await expect(legalGraphicImage('guarantee-notice-xx')).rejects.toThrow(LegalGraphicError)
    await expect(withLegalPages(await renderedWith(1), [notice])).rejects.toThrow(LegalGraphicError)
  })
})

describe('the label of a guarantee of durability (#433)', () => {
  const guarantee = { halfYears: 5, producer: 'Kraft & Söhne', model: 'K<2>' }

  it('is the file of the Commission byte for byte, with the digest its README names', async () => {
    const digest = '3414c8366823db39702d2557e614f882b530487ce589e903afdc98b7225e1ab1'
    const file = await readFile(
      new URL('../../assets/legal/durability-label-2026-03-19.svg', import.meta.url),
    )
    const readme = await readFile(new URL('../../assets/legal/README.md', import.meta.url), 'utf-8')

    expect(readme).toContain(digest)
    expect(createHash('sha256').update(file).digest('hex')).toBe(digest)
    expect(createHash('sha256').update(durabilityLabelSvg, 'utf8').digest('hex')).toBe(digest)
  })

  it('fills its three fields over the drawing, the model at the right edge, and escapes what it fills in', () => {
    const label = filledDurabilityLabel(durabilityLabelSvg, guarantee)

    expect(label).toContain('<use href="#durability-drawing"/>')
    expect(label).toContain('<tspan x="0" y="0">2,5</tspan>')
    expect(label).toContain('<tspan x="0" y="0">Kraft &amp; Söhne</tspan>')
    expect(label).toContain(
      'text-anchor="end" transform="translate(262.9 74.52)"><tspan x="0" y="0">K&lt;2&gt;</tspan>',
    )
    expect(label).toContain('class="durability-cls-3"')
    expect(label).toContain('viewBox="0 0 269.29 283.46"')
  })

  it('draws the file once without its fields, and changes nothing else but the names of its ids and classes', () => {
    const source = durabilityLabelSvg
    const drawing = durabilityLabelDrawing(source)
    const svg = source.slice(source.indexOf('<svg')).trimEnd()
    // The file between its opening and its closing tag, without the three
    // fields the labels fill in.
    const expected = svg
      .slice(svg.indexOf('>') + 1, -'</svg>'.length)
      .replace(
        '<text class="cls-5" transform="translate(6.32 74.52)"><tspan x="0" y="0">Brand/</tspan>' +
          '<tspan class="cls-19" x="28.34" y="0">T</tspan><tspan class="cls-22" x="33.61" y="0">rademark</tspan></text>',
        '',
      )
      .replace(
        '<text class="cls-5" transform="translate(196.75 74.52)"><tspan x="0" y="0">Model identifier</tspan></text>',
        '',
      )
      .replace(
        '<text class="cls-3" transform="translate(5.07 150.57)"><tspan x="0" y="0">XX</tspan></text>',
        '',
      )
    const inside = drawing.slice(
      drawing.indexOf('<symbol id="durability-drawing" viewBox="0 0 269.29 283.46">') +
        '<symbol id="durability-drawing" viewBox="0 0 269.29 283.46">'.length,
      -'</symbol></svg>'.length,
    )
    const back = inside
      .replaceAll('id="durability-', 'id="')
      .replaceAll('url(#durability-', 'url(#')
      .replaceAll('.durability-cls-', '.cls-')
      .replaceAll(
        /class="([^"]+)"/g,
        (_, names: string) => `class="${names.replaceAll('durability-cls-', 'cls-')}"`,
      )

    expect(back).toBe(expected)
    expect(drawing).not.toContain('Brand/')
    expect(drawing).not.toContain('Model identifier')
    expect(drawing).not.toContain('>XX<')
  })

  it('keeps a reference by href to an element of the file whole', () => {
    // The file of today refers by url(#...) alone; a new one may use an
    // element by href, and its reference must follow the id.
    const source = durabilityLabelSvg.replace(
      '</svg>',
      '<use href="#clippath"/><use xlink:href="#clippath-1"/></svg>',
    )
    const drawing = durabilityLabelDrawing(source)

    expect(drawing).toContain('id="durability-clippath"')
    expect(drawing).toContain('<use href="#durability-clippath"/>')
    expect(drawing).toContain('<use xlink:href="#durability-clippath-1"/>')
  })

  it('gives a label no id of its own, so that every label of a page uses the one drawing', () => {
    const label = filledDurabilityLabel(durabilityLabelSvg, guarantee)
    const drawing = durabilityLabelDrawing(durabilityLabelSvg)

    expect(label).not.toContain('id=')
    expect(drawing.split('id="durability-drawing"').length).toBe(2)
  })

  it('takes a dollar sign in a field as a dollar sign, never as a part of the file', () => {
    const label = filledDurabilityLabel(durabilityLabelSvg, {
      halfYears: 6,
      producer: "A$'B$`C",
      model: '$&$$',
    })

    expect(label).toContain('<tspan x="0" y="0">A$\'B$`C</tspan>')
    expect(label).toContain('<tspan x="0" y="0">$&amp;$$</tspan>')
    expect(label.split('<svg').length).toBe(2)
  })

  it('refuses a file whose fields do not stand where they should', () => {
    const source = durabilityLabelSvg.replace('Model identifier', 'Model')

    expect(() => durabilityLabelDrawing(source)).toThrow(LegalGraphicError)
  })
})
