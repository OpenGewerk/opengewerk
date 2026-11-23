import { type FormDefinition, ruleSet } from '@opengewerk/domain'
import { elektroRegistry, elektroRules } from '@opengewerk/gewerk-elektro'
import { describe, expect, it } from 'vitest'

import {
  photoCaption,
  photoCaptionLength,
  protocolPrintJob,
  type PrintedProtocol,
} from './protocol-print.js'

// One rule, measured against in two ways: a value may reach it, or it has to
// stay under it (opengewerk-haustechnik#93).
const definition: FormDefinition = {
  key: 'probe_protocol',
  version: 1,
  title: 'Probe',
  attachesTo: 'installation',
  sections: [
    {
      key: 'values',
      title: 'Werte',
      fields: [
        {
          kind: 'group',
          key: 'points',
          label: 'Messstellen',
          repeat: 'free',
          fields: [
            {
              kind: 'measurement',
              key: 'reached',
              label: 'Darf ihn erreichen',
              unit: 'volt',
              decimals: 0,
              limit: { kind: 'at_most', rule: 'probe.voltage' },
            },
            {
              kind: 'measurement',
              key: 'under',
              label: 'Bleibt unter ihm',
              unit: 'volt',
              decimals: 0,
              limit: { kind: 'below', rule: 'probe.voltage' },
            },
          ],
        },
      ],
    },
  ],
}

const protocol: PrintedProtocol = {
  definition,
  values: {
    points: [{ circuitId: null, circuit: null, values: { reached: 50_000, under: 50_000 } }],
  },
  performedOn: '2026-10-14',
  status: 'signed',
  keeper: { name: 'Probebetrieb', phone: null },
  installation: 'Probeanlage',
  appliance: null,
  site: '',
  rules: ruleSet([
    {
      key: 'probe.voltage',
      validFrom: '2026-01-01',
      validUntil: null,
      unit: 'volts',
      value: 50,
      source: 'Probevorschrift Nr. 1',
    },
  ]),
}

describe('a signature on a printed protocol', () => {
  const signed: FormDefinition = {
    ...definition,
    sections: [
      {
        key: 'result',
        title: 'Ergebnis',
        fields: [{ kind: 'signature', key: 'signature', label: 'Unterschrift' }],
      },
    ],
  }
  const printed = (signedAt: string) =>
    protocolPrintJob({
      ...protocol,
      definition: signed,
      values: { signature: { name: 'Petra Probe', path: 'M10,10L20,20', signedAt } },
    }).html

  /**
   * The day of a signature is printed as text, whatever the value holds: a
   * value that opens a comment would hide every signature after it.
   */
  it('names the day it was given on, as text', () => {
    expect(printed('2026-10-14T10:00:00Z')).toContain('Petra Probe, 14.10.2026')
    expect(printed('<!--------')).toContain('Petra Probe, --.--.&lt;!--')
  })
})

describe('the limits under a table of a printed protocol', () => {
  it('names a limit a value has to stay under as such, with the source of its rule', () => {
    const { html } = protocolPrintJob(protocol)

    expect(html).toContain(
      '<li><strong>Darf ihn erreichen:</strong> höchstens 50 V; Probevorschrift Nr. 1</li>',
    )
    expect(html).toContain(
      '<li><strong>Bleibt unter ihm:</strong> unter 50 V; Probevorschrift Nr. 1</li>',
    )
    // The same 50 V reach the first limit and stay within, and are outside the second.
    expect(html.match(/<td class="figure outside">50 !<\/td>/g)).toHaveLength(1)
  })
})

describe('a printed recurring inspection in version 2 (#1022)', () => {
  const second = elektroRegistry.definitionFor('vde-0105-100', 2)

  it('judges a circuit in the earthing system of the protocol and says table 11 under the table', () => {
    expect(second).not.toBeNull()

    const { html } = protocolPrintJob({
      ...protocol,
      definition: second as FormDefinition,
      values: {
        earthing_system: 'it',
        circuits: [
          { circuitId: 'k-1', circuit: null, values: { insulation_with_loads: 20 } },
          { circuitId: 'k-2', circuit: null, values: { insulation_with_loads: 11 } },
        ],
      },
      performedOn: '2026-11-20',
      rules: elektroRules,
    })

    // 50 Ω per volt in an IT system: 0,020 MΩ holds, 0,011 MΩ does not.
    expect(html.match(/<td class="figure outside">/g)).toHaveLength(1)
    expect(html).toContain(
      'nach Umgebung und Netzform des Stromkreises mindestens 300 Ω/V trocken, 150 Ω/V feucht, 50 Ω/V im IT-System, je Volt der Nennspannung des Protokolls, ohne Angabe 230 V, und 0,25 MΩ bei SELV und PELV; einen Stromkreis über 500 V beurteilt das Protokoll nicht, weil es seine Nennspannung nicht kennt',
    )
  })
})

describe('a printed protocol of a wallbox in version 2 (#1075)', () => {
  const second = elektroRegistry.definitionFor('vde-0100-722', 2)

  it('judges the tripping current by the rated residual current it names', () => {
    expect(second).not.toBeNull()

    const printed = (rated: string) =>
      protocolPrintJob({
        ...protocol,
        definition: second as FormDefinition,
        values: { rcd_rated_residual_current: rated, rcd_trip_current: 8000 },
        performedOn: '2026-11-20',
        rules: elektroRules,
      }).html

    // 8 mA lie between half and all of 10 mA, and under half of 30 mA.
    expect(printed('10')).not.toContain('außerhalb des Grenzwerts')
    expect(printed('30')).toContain('außerhalb des Grenzwerts')
  })

  it('names the range under the measuring, with its sources', () => {
    const legend = (values: Record<string, string>) =>
      protocolPrintJob({
        ...protocol,
        definition: second as FormDefinition,
        values,
        performedOn: '2026-11-20',
        rules: elektroRules,
      }).html

    expect(legend({})).toContain(
      '<li><strong>Auslösestrom IΔ:</strong> zwischen 15,1 und 30,0 mA; DIN VDE 0100-722 (VDE 0100-722):2019-06, 722.531.3.101; DIN EN 61008-1',
    )
    expect(legend({ rcd_rated_residual_current: '10' })).toContain(
      '<li><strong>Auslösestrom IΔ:</strong> zwischen 5,1 und 10,0 mA; DIN EN 61008-1',
    )
  })
})

describe('the next inspection on a printed protocol (#301)', () => {
  const recurring = elektroRegistry.definitionFor('vde-0105-100', 1)

  it('stands beside its interval, counted from the day of the test', () => {
    expect(recurring).not.toBeNull()

    const { html } = protocolPrintJob({
      ...protocol,
      definition: recurring as FormDefinition,
      values: { next_inspection_months: 48_000 },
      performedOn: '2026-09-18',
      rules: elektroRules,
    })

    expect(html).toContain(
      '<tr><th>Prüffrist bis zur nächsten Prüfung</th><td>48 Mon., nächste Prüfung bis zum 18.09.2030</td></tr>',
    )
  })

  it('is left out where the interval is not filled in', () => {
    const { html } = protocolPrintJob({
      ...protocol,
      definition: recurring as FormDefinition,
      values: {},
      performedOn: '2026-09-18',
      rules: elektroRules,
    })

    expect(html).toContain('<tr><th>Prüffrist bis zur nächsten Prüfung</th><td></td></tr>')
    expect(html).not.toContain('nächste Prüfung bis')
  })

  it('stands on the first inspection of a new installation, and only where it is sooner after an extension (#814, #822)', () => {
    const first = elektroRegistry.definitionFor('vde-0100-600', 3) as FormDefinition
    const printed = (occasion: string, months?: number) =>
      protocolPrintJob({
        ...protocol,
        definition: first,
        values: {
          occasion,
          ...(months === undefined ? {} : { next_inspection_months: months * 1000 }),
        },
        performedOn: '2026-11-02',
        rules: elektroRules,
      }).html

    expect(printed('new', 48)).toContain(
      '<tr><th>Prüffrist bis zur ersten Wiederholungsprüfung</th><td>48 Mon., nächste Prüfung bis zum 02.11.2030</td></tr>',
    )
    expect(printed('extension', 12)).toContain(
      '<tr><th>Prüffrist bis zur ersten Wiederholungsprüfung</th><td>12 Mon., nächste Prüfung bis zum 02.11.2027, wenn die Frist der letzten Prüfung der Anlage nicht früher endet</td></tr>',
    )
    expect(printed('change')).toContain(
      '<tr><th>Prüffrist bis zur ersten Wiederholungsprüfung</th><td>Nach einer Erweiterung oder Änderung bleibt die Frist der letzten Prüfung der Anlage stehen.</td></tr>',
    )
    expect(printed('change')).not.toContain('nächste Prüfung bis')
  })

  it('names the limits of version 4 under the table of the circuits, each with what it hangs on (#1021)', () => {
    const fourth = elektroRegistry.definitionFor('vde-0100-600', 4) as FormDefinition
    const html = protocolPrintJob({
      ...protocol,
      definition: fourth,
      values: {
        circuits: [
          {
            circuitId: 'k-1',
            circuit: {
              designation: 'F1',
              consumer: null,
              tripCharacteristic: 'b',
              ratedCurrentMilli: 16_000,
              ratedResidualCurrentMilli: 30,
              voltageClass: 'selv_pelv',
              rcdSelective: true,
            },
            values: { insulation_resistance: 600, rcd_trip_time: 400_000 },
          },
        ],
      },
      performedOn: '2026-11-20',
      rules: elektroRules,
    }).html

    expect(html).toContain(
      'nach der Nennspannung des Stromkreises mindestens 1,00 MΩ bis 500 V, 0,50 MΩ bei SELV und PELV, 1,00 MΩ über 500 V',
    )
    expect(html).toContain(
      'höchstens 0,6666 × U0 / Ia aus der Schutzeinrichtung des Stromkreises, darüber eine genauere Bewertung nach Anhang D',
    )
    expect(html).toContain('über 0,5 × IΔn bis 1 × IΔn des Stromkreises')
    expect(html).toContain('höchstens 300 ms, bei einer selektiven RCD zwischen 130 ms und 500 ms')
  })
})

describe('the test of an appliance on paper (#303)', () => {
  const test = elektroRegistry.definitionFor('dguv-v3', 1)
  const printed = (
    appliance: Partial<NonNullable<PrintedProtocol['appliance']>> & {
      readonly protectionClass: 'I' | 'II' | 'III'
    },
    values: PrintedProtocol['values'],
    definition = test,
  ): string =>
    protocolPrintJob({
      ...protocol,
      definition: definition as FormDefinition,
      values,
      performedOn: '2026-11-02',
      installation: '002 Verlängerungsleitung 25 m, Schutzklasse I, Anschlussleitung 25 m',
      appliance: {
        cordLengthMilli: null,
        cordCrossSectionMilli: null,
        heatingPowerWatts: null,
        ...appliance,
      },
      rules: elektroRules,
    }).html

  it('judges a value by the limit worked out of the appliance, and names it with its source', () => {
    expect(test).not.toBeNull()

    const lead = { protectionClass: 'I' as const, cordLengthMilli: 25_000 }

    // 0,3 Ω up to 5 m and 0,1 Ω for each of the three lengths of 7,5 m begun beyond.
    expect(printed(lead, { protective_conductor: 650 })).toContain(
      '0,65 Ω <span class="outside">außerhalb des Grenzwerts</span>',
    )
    expect(printed(lead, { protective_conductor: 600 })).not.toContain('außerhalb des Grenzwerts')
    expect(printed(lead, {})).toContain(
      '<strong>Schutzleiterwiderstand RPE:</strong> höchstens 0,60 Ω; DGUV Information 203-070',
    )
  })

  it('says why there is no limit where the protection class has no protective conductor', () => {
    expect(printed({ protectionClass: 'II', cordLengthMilli: null }, {})).toContain(
      '<strong>Schutzleiterwiderstand RPE:</strong> Ein Gerät dieser Schutzklasse hat keinen Schutzleiter.',
    )
    expect(printed({ protectionClass: 'II', cordLengthMilli: null }, {})).toContain(
      '<strong>Isolationswiderstand Riso:</strong> mindestens 2,00 MΩ; DGUV Information 203-070',
    )
  })

  it('names the limits of heating elements and of a lead over 1,5 mm² in version 3 (opengewerk#816)', () => {
    const third = elektroRegistry.definitionFor('dguv-v3', 3)
    const heater = { protectionClass: 'I' as const, heatingPowerWatts: 5_000 }
    const drum = {
      protectionClass: 'I' as const,
      cordLengthMilli: 50_000,
      cordCrossSectionMilli: 2_500,
    }

    expect(printed(heater, {}, third)).toContain(
      '<strong>Schutzleiterstrom IPE:</strong> höchstens 5,00 mA; DGUV Information 203-070',
    )
    expect(printed(heater, { insulation: 100 }, third)).toContain(
      '0,10 MΩ <span class="outside">außerhalb des Grenzwerts</span>',
    )
    expect(printed({ ...heater, heatingPowerWatts: 2_000 }, {}, third)).toContain(
      '<strong>Isolationswiderstand Riso:</strong> mindestens 0,30 MΩ; DGUV Information 203-070',
    )
    // 50 m of 2,5 mm²: 50 / (56 · 2,5) Ω and 0,1 Ω, 0,457 Ω, written to the hundredth a value
    // is measured in: 0,45 Ω is within, 0,46 Ω is not.
    expect(printed(drum, { protective_conductor: 460 }, third)).toContain(
      '0,46 Ω <span class="outside">außerhalb des Grenzwerts</span>',
    )
    expect(printed(drum, {}, third)).toContain(
      '<strong>Schutzleiterwiderstand RPE:</strong> höchstens 0,45 Ω; DGUV Information 203-070',
    )
  })
})

describe('the commissioning protocol after VDE-AR-N 4105 on paper (#304)', () => {
  const commissioning = elektroRegistry.definitionFor('vde-ar-n-4105', 1)

  it('names the day of the commissioning, the power and the day the system first ran with the grid', () => {
    expect(commissioning).not.toBeNull()

    const { html } = protocolPrintJob({
      ...protocol,
      definition: commissioning as FormDefinition,
      values: {
        operator: 'Familie Berger\nLindenweg 4, 68535 Edingen-Neckarhausen',
        apparent_power: 9500,
        module_power: 9460,
        feed_in_limit: 70_000,
        grid_parallel_on: '2026-11-04',
      },
      performedOn: '2026-11-02',
      rules: elektroRules,
    })

    expect(html).toContain('<p class="where">In Betrieb gesetzt am 02.11.2026</p>')
    expect(html).not.toContain('Geprüft am')
    expect(html).toContain(
      '<tr><th>Anlagenbetreiber</th><td>Familie Berger<br>Lindenweg 4, 68535 Edingen-Neckarhausen</td></tr>',
    )
    expect(html).toContain('<tr><th>Maximale Scheinleistung SAmax</th><td>9,50 kVA</td></tr>')
    expect(html).toContain('<tr><th>Modulleistung</th><td>9,46 kWp</td></tr>')
    expect(html).toContain('<tr><th>Erster Netzparallelbetrieb</th><td>04.11.2026</td></tr>')
    // 70 % is over the limit of the Solarspitzengesetz, which is named with its source.
    expect(html).toContain(
      '<tr><th>Begrenzung der Einspeisung</th><td>70 % <span class="outside">außerhalb des Grenzwerts</span></td></tr>',
    )
    expect(html).toContain(
      '<strong>Begrenzung der Einspeisung:</strong> höchstens 60 %; § 9 Abs. 2',
    )
    expect(html).toContain('<tr><th>Unterschrift des Anlagenbetreibers</th>')
    expect(html).toContain('<tr><th>Unterschrift des Elektrofachbetriebs</th>')
  })
})

describe('a photo on a printed protocol (#817)', () => {
  const withPhoto: FormDefinition = {
    key: 'probe-photo',
    version: 1,
    title: 'Probe mit Foto',
    attachesTo: 'installation',
    sections: [
      {
        key: 'result',
        title: 'Ergebnis',
        fields: [{ kind: 'photo', key: 'photo', label: 'Foto' }],
      },
    ],
  }
  const photo = '01a1d37b-f41b-7bc2-9541-d376ec96153d'
  const printed = (more: Partial<PrintedProtocol>) =>
    protocolPrintJob({ ...protocol, definition: withPhoto, values: { photo }, ...more }).html

  it('is shown where the page has its picture', () => {
    const html = printed({
      photos: new Map([
        [photo, { title: 'leitung.png', mediaType: 'image/png', bytes: new Uint8Array([1, 2]) }],
      ]),
    })

    expect(html).toContain('<img src="data:image/png;base64,AQI=" alt="leitung.png">')
  })

  it('says where it lies otherwise: at the installation, the appliance or the job', () => {
    expect(printed({ photoHome: 'installation' })).toContain('bei den Dateien der Anlage')
    expect(printed({ photoHome: 'appliance' })).toContain('bei den Dateien des Geräts')
    expect(printed({ photoHome: 'job' })).toContain('bei den Dateien des Auftrags')
  })
})

describe('the name a photo is printed with (#817)', () => {
  it('is cut, so that a long name keeps within the room of the request', () => {
    expect(photoCaption('leitung.jpg')).toBe('leitung.jpg')
    expect([...photoCaption('&'.repeat(100_000))]).toHaveLength(photoCaptionLength + 1)

    const html = protocolPrintJob({
      ...protocol,
      definition: {
        key: 'probe-photo',
        version: 1,
        title: 'Probe mit Foto',
        attachesTo: 'installation',
        sections: [
          {
            key: 'result',
            title: 'Ergebnis',
            fields: [{ kind: 'photo', key: 'photo', label: 'Foto' }],
          },
        ],
      },
      values: { photo: 'p-1' },
      photos: new Map([
        ['p-1', { title: '&'.repeat(100_000), mediaType: 'image/png', bytes: new Uint8Array([1]) }],
      ]),
    }).html

    expect(html.length).toBeLessThan(200_000)
  })
})
