import ExcelJS from 'exceljs'
import { round2 } from './siigo.helpers.js'
import type { SiigoExcelRow } from './siigo.calculator.js'

export async function buildSiigoExcelBuffer(
  rows: SiigoExcelRow[],
  logInfo: Record<string, string | number>,
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook()
  workbook.creator = 'Finto - Consultas Siigo'
  workbook.created = new Date()

  // ==========================================
  // HOJA 1: INFORME
  // ==========================================
  const sheetInforme = workbook.addWorksheet('INFORME', {
    views: [{ state: 'frozen', ySplit: 1 }],
  })

  const headers = [
    'No. Comprobante',
    'Fecha de elaboración',
    'Identificación',
    'Sucursal',
    'Cliente',
    'Código producto',
    'Descripción producto',
    'Valor bruto',
    'Descuento',
    'Subtotal',
    'Impuesto cargo',
    'Impuesto retención',
    'Cargo en totales',
    'Descuento en totales',
    'Total',
  ]

  const headerRow = sheetInforme.addRow(headers)
  headerRow.height = 28
  headerRow.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 }
    cell.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FF1B365D' }, // Azul corporativo elegante
    }
    cell.alignment = { vertical: 'middle', horizontal: 'center' }
    cell.border = {
      top:    { style: 'thin', color: { argb: 'FFD9D9D9' } },
      bottom: { style: 'medium', color: { argb: 'FF0F1F38' } },
      left:   { style: 'thin', color: { argb: 'FFD9D9D9' } },
      right:  { style: 'thin', color: { argb: 'FFD9D9D9' } },
    }
  })

  for (const r of rows) {
    const row = sheetInforme.addRow(r)
    row.height = 20

    const dateCell = row.getCell(2)
    if (dateCell.value instanceof Date) {
      dateCell.numFmt = 'dd/mm/yyyy'
      dateCell.alignment = { horizontal: 'center', vertical: 'middle' }
    }

    for (let colIdx = 8; colIdx <= 15; colIdx++) {
      const cell = row.getCell(colIdx)
      cell.numFmt = '"$"#,##0.00;[Red]("$"#,##0.00);"-"'
      cell.alignment = { horizontal: 'right', vertical: 'middle' }
    }

    row.eachCell({ includeEmpty: true }, (cell) => {
      cell.border = {
        bottom: { style: 'hair', color: { argb: 'FFE0E0E0' } },
        right:  { style: 'hair', color: { argb: 'FFE0E0E0' } },
      }
    })
  }

  sheetInforme.autoFilter = {
    from: { row: 1, column: 1 },
    to:   { row: rows.length + 1, column: headers.length },
  }

  sheetInforme.columns.forEach((column, index) => {
    let maxLength = headers[index] ? headers[index]!.length : 12
    const sampleLimit = Math.min(rows.length, 500)
    for (let i = 0; i < sampleLimit; i++) {
      const val = rows[i]?.[index]
      if (val !== null && val !== undefined) {
        const str = val instanceof Date ? '10/10/2025' : String(val)
        if (str.length > maxLength) maxLength = str.length
      }
    }
    column.width = Math.min(Math.max(maxLength + 4, 12), 48)
  })

  // ==========================================
  // HOJA 2: RESUMEN
  // ==========================================
  const sheetResumen = workbook.addWorksheet('RESUMEN')
  sheetResumen.views = [{ showGridLines: true }]

  let totalFacturas = 0
  let totalNotasCredito = 0
  let totalBruto = 0
  let totalDescuento = 0
  let totalSubtotal = 0
  let totalImpuestos = 0
  let totalNeto = 0

  const mesesMap: Record<string, { subtotal: number; impuestos: number; total: number; lineas: number }> = {}
  const comprobantesVistos = new Set<string>()

  for (const r of rows) {
    const comp = String(r[0] || '')
    const fecha = r[1] instanceof Date ? r[1] : null
    const bruto = Number(r[7]) || 0
    const desc = Number(r[8]) || 0
    const sub = Number(r[9]) || 0
    const imp = Number(r[10]) || 0
    const tot = Number(r[14]) || 0

    if (comp && !comprobantesVistos.has(comp)) {
      comprobantesVistos.add(comp)
      if (comp.startsWith('NC')) {
        totalNotasCredito++
      } else {
        totalFacturas++
      }
    }

    totalBruto += bruto
    totalDescuento += desc
    totalSubtotal += sub
    totalImpuestos += imp
    totalNeto += tot

    if (fecha) {
      const ym = `${fecha.getFullYear()}-${String(fecha.getMonth() + 1).padStart(2, '0')}`
      if (!mesesMap[ym]) {
        mesesMap[ym] = { subtotal: 0, impuestos: 0, total: 0, lineas: 0 }
      }
      mesesMap[ym]!.subtotal += sub
      mesesMap[ym]!.impuestos += imp
      mesesMap[ym]!.total += tot
      mesesMap[ym]!.lineas++
    }
  }

  sheetResumen.mergeCells('B2:E2')
  const titleCell = sheetResumen.getCell('B2')
  titleCell.value = 'RESUMEN EJECUTIVO DE VENTAS'
  titleCell.font = { size: 16, bold: true, color: { argb: 'FF1B365D' } }

  const kpis: [string, number][] = [
    ['Total Facturas emitidas', totalFacturas],
    ['Total Notas Crédito', totalNotasCredito],
    ['Total Líneas / Ítems', rows.length],
    ['Total Bruto', round2(totalBruto)],
    ['Total Descuentos', round2(totalDescuento)],
    ['Total Subtotal', round2(totalSubtotal)],
    ['Total Impuestos Cargo', round2(totalImpuestos)],
    ['TOTAL NETO GENERAL', round2(totalNeto)],
  ]

  let kpiRowIndex = 4
  sheetResumen.getCell(`B${kpiRowIndex}`).value = 'Concepto'
  sheetResumen.getCell(`C${kpiRowIndex}`).value = 'Valor'
  sheetResumen.getRow(kpiRowIndex).font = { bold: true }
  sheetResumen.getRow(kpiRowIndex).fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FFE6ECF5' },
  }

  kpiRowIndex++
  kpis.forEach(([concepto, val]) => {
    sheetResumen.getCell(`B${kpiRowIndex}`).value = concepto
    const vCell = sheetResumen.getCell(`C${kpiRowIndex}`)
    vCell.value = val
    if (
      typeof val === 'number' &&
      concepto.includes('Total') &&
      !concepto.includes('Facturas') &&
      !concepto.includes('Líneas') &&
      !concepto.includes('Notas')
    ) {
      vCell.numFmt = '"$"#,##0.00;[Red]("$"#,##0.00);"-"'
    }
    if (concepto === 'TOTAL NETO GENERAL') {
      sheetResumen.getRow(kpiRowIndex).font = { bold: true, size: 12 }
      sheetResumen.getRow(kpiRowIndex).fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FFD2E3FC' },
      }
    }
    kpiRowIndex++
  })

  kpiRowIndex += 2
  sheetResumen.getCell(`B${kpiRowIndex}`).value = 'DESGLOSE POR MES'
  sheetResumen.getCell(`B${kpiRowIndex}`).font = { bold: true, size: 13, color: { argb: 'FF1B365D' } }

  kpiRowIndex++
  const monthHeaders = ['Periodo (Año-Mes)', 'Líneas', 'Subtotal', 'Impuestos', 'Total Neto']
  const monthHeadRow = sheetResumen.getRow(kpiRowIndex)
  monthHeaders.forEach((h, idx) => {
    const colLetter = String.fromCharCode(66 + idx)
    sheetResumen.getCell(`${colLetter}${kpiRowIndex}`).value = h
  })
  monthHeadRow.font = { bold: true, color: { argb: 'FFFFFFFF' } }
  monthHeadRow.fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FF2A4D69' },
  }

  const sortedMonths = Object.keys(mesesMap).sort()
  sortedMonths.forEach(ym => {
    kpiRowIndex++
    const m = mesesMap[ym]!
    sheetResumen.getCell(`B${kpiRowIndex}`).value = ym
    sheetResumen.getCell(`C${kpiRowIndex}`).value = m.lineas
    sheetResumen.getCell(`D${kpiRowIndex}`).value = round2(m.subtotal)
    sheetResumen.getCell(`E${kpiRowIndex}`).value = round2(m.impuestos)
    sheetResumen.getCell(`F${kpiRowIndex}`).value = round2(m.total)

    sheetResumen.getCell(`D${kpiRowIndex}`).numFmt = '"$"#,##0.00;[Red]("$"#,##0.00);"-"'
    sheetResumen.getCell(`E${kpiRowIndex}`).numFmt = '"$"#,##0.00;[Red]("$"#,##0.00);"-"'
    sheetResumen.getCell(`F${kpiRowIndex}`).numFmt = '"$"#,##0.00;[Red]("$"#,##0.00);"-"'
  })

  sheetResumen.columns.forEach(col => { col.width = 22 })

  // ==========================================
  // HOJA 3: LOG
  // ==========================================
  const sheetLog = workbook.addWorksheet('LOG')
  sheetLog.addRow(['Parámetro / Paso', 'Valor'])
  sheetLog.getRow(1).font = { bold: true }
  sheetLog.getRow(1).fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FFEFEFEF' },
  }

  for (const [k, v] of Object.entries(logInfo)) {
    sheetLog.addRow([k, String(v)])
  }
  sheetLog.columns = [{ width: 32 }, { width: 45 }]

  const arrayBuffer = await workbook.xlsx.writeBuffer()
  return Buffer.from(arrayBuffer)
}
