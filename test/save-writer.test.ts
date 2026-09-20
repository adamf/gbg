import { describe, expect, it } from 'vitest'

import { CHARACTER_RECORD_SIZE, ITEM_RECORD_SIZE, readCharacter, readItems } from '../src/formats/character.js'
import { readSavedGame } from '../src/formats/library.js'
import { writeCharacter, writeItems, writeSavedGame } from '../src/formats/save-writer.js'
import { EclMemory, POOL_ADDRESSES } from '../src/engine/ecl-vm.js'

describe('writing the original’s files', () => {
  it('round-trips a character record and keeps unmodelled bytes', () => {
    const data = new Uint8Array(CHARACTER_RECORD_SIZE)
    for (let i = 0; i < data.length; i++) data[i] = (i * 7) & 0xff
    data[0] = 5
    data.set([...'SMITH'].map((c) => c.charCodeAt(0)), 1)
    data[0x2d] = 40; data[0x111] = 55; data[0x112] = 54; data[0xa9] = 50; data[0x10c] = 0
    const c = readCharacter(data)
    c.hpCurrent = 3
    c.experience = 123456
    c.money[3] = 77
    const out = writeCharacter(c)
    const back = readCharacter(out)
    expect(back.name).toBe('SMITH')
    expect(back.hpCurrent).toBe(3)
    expect(back.experience).toBe(123456)
    expect(back.money[3]).toBe(77)
    expect(back.thac0).toBe(c.thac0)
    expect(back.ac).toBe(c.ac)
    expect(out[0xd0]).toBe(data[0xd0]) // a pointer this program never touches
  })

  it('round-trips an inventory', () => {
    const data = new Uint8Array(ITEM_RECORD_SIZE)
    data[0] = 5
    data.set([...'Flail'].map((c) => c.charCodeAt(0)), 1)
    data[0x2e] = 12; data[0x31] = 12; data[0x34] = 1; data[0x37] = 150; data[0x3a] = 3
    const [item] = readItems(data)
    item!.readied = false
    const back = readItems(writeItems([item!]))[0]!
    expect(back).toMatchObject({ name: 'Flail', type: 12, readied: false, weight: 150, value: 3 })
  })

  it('writes a saved game the reader accepts, from script memory', () => {
    const memory = new EclMemory()
    memory.loadImage(new Uint8Array(2 + 100), 0x9900)
    memory.write(POOL_ADDRESSES.lastEclBlock, 20)
    memory.write(POOL_ADDRESSES.timeHour, 11)
    const file = writeSavedGame({
      area: 2,
      globals: memory.bytesOf(POOL_ADDRESSES.globalsBase, 0x400),
      areaScratch: memory.bytesOf(POOL_ADDRESSES.areaScratchBase, 0x400),
      extra: memory.bytesOf(POOL_ADDRESSES.extraBase, 0x200),
      script: memory.imageBytes(),
      position: { col: 4, row: 1, facing: 0, wallAhead: 0, cellEvent: 0 },
      party: ['CHRDATB1', 'CHRDATB2'],
    })
    const saved = readSavedGame(file)!
    expect(saved.area).toBe(2)
    expect(saved.party).toEqual(['CHRDATB1', 'CHRDATB2'])
    const again = new EclMemory()
    again.loadWords(POOL_ADDRESSES.globalsBase, saved.globals)
    expect(again.read(POOL_ADDRESSES.lastEclBlock)).toBe(20)
    expect(again.read(POOL_ADDRESSES.timeHour)).toBe(11)
  })
})
