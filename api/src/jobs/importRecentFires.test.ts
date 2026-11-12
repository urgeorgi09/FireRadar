import { afterEach, describe, expect, it, vi } from 'vitest'

const { query } = vi.hoisted(() => ({ query: vi.fn() }))
vi.mock('../db/client.js', () => ({
  default: Object.assign(query, { json: vi.fn(value => value) }),
}))
vi.mock('../services/bulgariaBoundary.js', () => ({
  loadBulgariaBoundaryGeoJSON: () => '{"type":"Polygon","coordinates":[]}',
}))

import { importRecentFires, parseRecentFirmsCsv } from './importRecentFires.js'

const csv = [
  'latitude,longitude,bright_ti4,acq_date,acq_time,satellite,instrument,confidence',
  '42.7,23.3,330.1,2026-11-07,1205,Suomi-NPP,VIIRS,n',
  '50,23.3,330.1,2026-11-07,1205,Suomi-NPP,VIIRS,h',
  '42.7,23.3,330.1,2026-11-07,1205,Suomi-NPP,VIIRS,l',
].join('\n')
const firmsFormatCsv = [
  'country,latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,satellite,instrument,confidence,version,bright_ti5,frp,daynight',
  'BGR,42.7,23.3,330.1,0.5,0.6,2026-11-07,1205,N,VIIRS,n,2.0,290.5,1.2,D',
].join('\n')

describe('recent FIRMS import', () => {
  const previousKey = process.env.FIRMS_MAP_KEY

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    vi.clearAllMocks()
    if (previousKey === undefined) delete process.env.FIRMS_MAP_KEY
    else process.env.FIRMS_MAP_KEY = previousKey
  })

  it('skips invalid coordinates and detections below nominal confidence', () => {
    const rows = parseRecentFirmsCsv(csv)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      lat: 42.7,
      lon: 23.3,
      confidence: 'nominal',
      source_id: 'firms-nrt-Suomi-NPP-VIIRS-2026-11-07-1205-42.7-23.3',
    })
  })

  it('treats an empty FIRMS response as no detections', () => {
    expect(parseRecentFirmsCsv('')).toEqual([])
    expect(parseRecentFirmsCsv('\n')).toEqual([])
  })

  it('rejects a CSV response missing required FIRMS columns', () => {
    expect(() => parseRecentFirmsCsv('latitude,longitude\n42.7,23.3'))
      .toThrow('FIRMS CSV липсват задължителни колони')
  })

  it('parses the standard FIRMS VIIRS CSV column layout', () => {
    expect(parseRecentFirmsCsv(firmsFormatCsv)).toMatchObject([{
      lat: 42.7,
      lon: 23.3,
      confidence: 'nominal',
      source_id: 'firms-nrt-N-VIIRS-2026-11-07-1205-42.7-23.3',
    }])
  })

  it('does not insert detections that already exist by source_id', async () => {
    process.env.FIRMS_MAP_KEY = 'test-key'
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, text: async () => csv }))
    query.mockResolvedValue([])

    await expect(importRecentFires()).resolves.toBe(0)
    const statement = query.mock.calls[0][0].join('')
    expect(statement).toContain('ON CONFLICT (source_id) DO NOTHING')
    expect(statement).toContain('ST_Intersects')
  })

  it('imports recent detections from NOAA-20 and NOAA-21 when SNPP has none', async () => {
    process.env.FIRMS_MAP_KEY = 'test-key'
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      const text = url.includes('VIIRS_SNPP_NRT')
        ? `${firmsFormatCsv.split('\n')[0]}`
        : firmsFormatCsv.replace('2026-11-07,1205,N,VIIRS', `2026-11-07,${url.includes('NOAA20') ? '1205' : '1206'},${url.includes('NOAA20') ? 'NOAA-20' : 'NOAA-21'},VIIRS`)
      return { ok: true, text: async () => text } as Response
    })
    vi.stubGlobal('fetch', fetchMock)
    query.mockResolvedValue([{ id: 1 }, { id: 2 }])

    await expect(importRecentFires()).resolves.toBe(2)
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual(expect.arrayContaining([
      expect.stringContaining('/VIIRS_SNPP_NRT/'),
      expect.stringContaining('/VIIRS_NOAA20_NRT/'),
      expect.stringContaining('/VIIRS_NOAA21_NRT/'),
    ]))
    expect(query.mock.calls[0][1]).toContainEqual(expect.objectContaining({
      source_id: expect.stringContaining('NOAA-20'),
    }))
    expect(query.mock.calls[0][1]).toContainEqual(expect.objectContaining({
      source_id: expect.stringContaining('NOAA-21'),
    }))
  })

  it('retries an unavailable FIRMS API and leaves the job non-fatal', async () => {
    process.env.FIRMS_MAP_KEY = 'test-key'
    const fetchMock = vi.fn().mockRejectedValue(new Error('network unavailable'))
    vi.stubGlobal('fetch', fetchMock)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(globalThis, 'setTimeout').mockImplementation((callback: TimerHandler) => {
      if (typeof callback === 'function') callback()
      return 0 as unknown as ReturnType<typeof setTimeout>
    })

    await expect(importRecentFires()).resolves.toBe(0)
    expect(fetchMock).toHaveBeenCalledTimes(9)
    expect(query).not.toHaveBeenCalled()
    expect(console.error).toHaveBeenCalledTimes(4)
  })
})
