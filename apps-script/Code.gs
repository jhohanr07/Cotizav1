/**
 * BNH Medical — Calculadora de Financiamiento
 * ------------------------------------------------------------------
 * Backend en Google Apps Script, vinculado al Google Sheet que actúa
 * como base de datos de la calculadora.
 *
 * Hojas esperadas en el Spreadsheet:
 *
 *  1) "PRECIO EQUIPOS"  (catálogo de precios)
 *     Encabezados fila 1: ID | Nombre | Categoria | Credito | Contado |
 *                         Base ajustada | IVA ajustado
 *     - "Categoria" debe coincidir con un valor de la columna A de la
 *       hoja "CATEGORIA" (TeAir, MX, Consona, Gama Alta, ...).
 *     - "Credito" y "Contado" son los precios del equipo para cada tipo de venta.
 *     - "IVA ajustado" (columna G) es el I.V.A. que se usa al activar el
 *       interruptor "Ajustar" de la calculadora. Si es 0 o está vacío, el
 *       equipo no tiene ajuste y se usa el I.V.A. normal.
 *
 *  1b) "CATEGORIA"  (condiciones de financiamiento por categoría)
 *     Encabezados fila 1: Categoria | Inicial minima | Inicial sugerida | 12 | 15 | 18
 *     - Columna A alimenta el desplegable de categoría (valores únicos).
 *     - Inicial minima / sugerida: texto tipo "REDONDEAR.MAS(Precio*0.20; -2)"
 *       (se lee el porcentaje que multiplica a "Precio" y, si existe, el
 *       redondeo) o directamente un número (0.20 / 20%).
 *     - Columnas 12 / 15 / 18 (plazos en meses): texto tipo
 *       "=(1.30 ^ (1 / 18))" (factor 1.30 a lo largo del plazo; la tasa
 *       mensual es 1.30^(1/18) - 1). "Sin calculo" o vacío = plazo no
 *       disponible para esa categoría.
 *
 *  2) "FUNEL DE VENTA"  (registro de cotizaciones generadas)
 *     Se crea automáticamente con encabezados la primera vez que se
 *     guarda una cotización.
 *
 *  3) "VENDEDORES"  (alimenta el desplegable de vendedor y la copia
 *     del correo)
 *     Encabezados fila 1: Nombre | Email
 *     Si el nombre de vendedor recibido coincide (sin distinguir
 *     mayúsculas/acentos) con una fila de esta hoja, se agrega su
 *     correo en copia (CC) al enviar la propuesta.
 *
 * Por cada cotización enviada se genera un PDF (formato "Cotización de
 * Servicios" de BNH Medical, sin RIF ni dirección del cliente) que se
 * adjunta al correo. Se arma con el servicio nativo DocumentApp/DriveApp
 * (no requiere habilitar servicios avanzados) y reproduce la
 * estructura y los colores de la plantilla original, aunque sin el
 * degradado decorativo del encabezado.
 *
 * Endpoints:
 *  - GET  ?action=getEquipos    -> { success, equipos: [...] }
 *  - GET  ?action=getCategorias -> { success, categorias: [...] }
 *  - GET  ?action=getVendedores -> { success, vendedores: [nombres] }
 *  - POST { action: "saveQuote", ... }
 *                                -> { success, numero, warning? }
 *
 * Despliegue:
 *  1. Abre el Google Sheet que usarás como base de datos.
 *  2. Extensiones > Apps Script.
 *  3. Reemplaza el contenido de Code.gs por este archivo.
 *  4. Implementar > Nueva implementación > Tipo "Aplicación web".
 *       Ejecutar como: Yo (tu cuenta, dueña del Sheet)
 *       Quién tiene acceso: Cualquier usuario
 *     (autoriza los permisos: Sheets, Gmail/MailApp, Docs y Drive; los
 *     dos últimos son nuevos porque ahora se genera el PDF).
 *  5. Copia la URL de la implementación y colócala como
 *     NEXT_PUBLIC_APPS_SCRIPT_URL en las variables de entorno del
 *     proyecto Next.js (Vercel).
 */

var SHEET_PRECIOS = "PRECIO EQUIPOS";
var SHEET_CATEGORIA = "CATEGORIA";
var SHEET_FUNEL = "FUNEL DE VENTA";
var SHEET_VENDEDORES = "VENDEDORES";

// Color de marca reutilizado en el correo y en el PDF (mismo tono que
// el botón "Enviar cotización" del frontend).
var BRAND_COLOR = "#0d6f91";
var DARK_COLOR = "#123047";

// Datos fijos del emisor, tal como aparecen en la plantilla de cotización.
var EMISOR = {
  nombre: "BNH Equipos y Suministros Médicos, S.A.",
  rif: "J-50348768-2",
  direccionLineas: [
    "Calle B, Edif. Conjunto Ciudad Center, Torre F, Piso 1, Ofic. 12-F",
    "Urb. Industrial Boleíta Norte, Caracas, Miranda. Zona Postal 1071",
  ],
  web: "bnhmedical.com",
  instagram: "@bnhmedical",
};

var FUNEL_HEADERS = [
  "N° Cotización",
  "Fecha",
  "Vendedor",
  "Lead",
  "Telefono",
  "Email",
  "Equipo",
  "Categoria",
  "Base Imponible",
  "Monto Inicial",
  "Cuotas",
  "Cuota Mensual",
  "Total a Pagar",
  "IVA Financiado",
  "IVA a Pagar",
  "Precio Contado",
  "IVA Contado",
  "Total Contado",
  "IVA Credito",
  "Total Credito (Base + IVA)",
  "IVA Ajustado",
];

function doGet(e) {
  try {
    var action = e.parameter.action;

    if (action === "getEquipos") {
      return jsonResponse_({ success: true, equipos: getEquipos_() });
    }

    if (action === "getCategorias") {
      return jsonResponse_({ success: true, categorias: getCategorias_() });
    }

    if (action === "getVendedores") {
      return jsonResponse_({ success: true, vendedores: getVendedores_() });
    }

    return jsonResponse_({ success: false, error: "Acción no reconocida." });
  } catch (err) {
    return jsonResponse_({ success: false, error: String(err) });
  }
}

function doPost(e) {
  try {
    var body = JSON.parse(e.postData.contents);

    if (body.action === "saveQuote") {
      return jsonResponse_(saveQuoteAndNotify_(body));
    }

    return jsonResponse_({ success: false, error: "Acción no reconocida." });
  } catch (err) {
    return jsonResponse_({ success: false, error: String(err) });
  }
}

/** Lee toda la hoja de precios en una sola lectura por lotes (sin acceso celda a celda). */
function getEquipos_() {
  var sheet = getSheet_(SHEET_PRECIOS);
  var values = sheet.getDataRange().getValues();

  if (values.length < 2) return [];

  var headers = values[0].map(function (h) {
    return normalizeName_(h);
  });

  var idxId = headers.indexOf("id");
  var idxNombre = headers.indexOf("nombre");
  var idxCategoria = headers.indexOf("categoria");
  var idxCredito = headers.indexOf("credito");
  if (idxCredito === -1) idxCredito = headers.indexOf("precio"); // compatibilidad con la hoja anterior
  var idxContado = headers.indexOf("contado");
  var idxBaseAj = headers.indexOf("base ajustada");
  var idxIvaAj = headers.indexOf("iva ajustado");

  if (idxNombre === -1 || idxCredito === -1) {
    throw new Error(
      'La hoja "' + SHEET_PRECIOS + '" debe tener columnas "Nombre" y "Credito".'
    );
  }

  var rows = values.slice(1);
  var equipos = [];

  for (var i = 0; i < rows.length; i++) {
    var row = rows[i];
    if (!row[idxNombre]) continue;

    equipos.push({
      // La columna ID de la hoja se repite (MX, N7, ...): el id único es el N° de fila.
      id: "r" + (i + 2),
      codigo: idxId !== -1 ? String(row[idxId] || "") : "",
      nombre: String(row[idxNombre]),
      categoria: idxCategoria !== -1 ? String(row[idxCategoria]).trim() : "",
      precioCredito: toNumber_(row[idxCredito]),
      precioContado: idxContado !== -1 ? toNumber_(row[idxContado]) : 0,
      baseAjustada: idxBaseAj !== -1 ? toNumber_(row[idxBaseAj]) : 0,
      ivaAjustado: idxIvaAj !== -1 ? toNumber_(row[idxIvaAj]) : 0,
    });
  }

  return equipos;
}

/**
 * Lee la hoja "CATEGORIA" y devuelve una entrada por categoría (columna A,
 * valores únicos) con sus condiciones de financiamiento ya interpretadas.
 */
function getCategorias_() {
  var sheet = getSheet_(SHEET_CATEGORIA);
  var values = sheet.getDataRange().getValues();

  if (values.length < 2) return [];

  var headers = values[0].map(function (h) {
    return String(h).trim();
  });
  var norm = headers.map(normalizeName_);

  var idxCat = norm.indexOf("categoria");
  if (idxCat === -1) idxCat = 0;
  var idxMin = norm.indexOf("inicial minima");
  var idxSug = norm.indexOf("inicial sugerida");

  // Columnas de plazo: cualquier encabezado que contenga un número (12, 15, 18, "12 meses")
  var termCols = [];
  for (var c = 0; c < headers.length; c++) {
    if (c === idxCat || c === idxMin || c === idxSug) continue;
    var m = headers[c].match(/^(\d+)/);
    if (m) termCols.push({ col: c, meses: Number(m[1]) });
  }

  var byKey = {};
  var order = [];

  for (var i = 1; i < values.length; i++) {
    var row = values[i];
    var nombre = String(row[idxCat] || "").trim();
    if (!nombre) continue;

    var key = normalizeName_(nombre);
    if (!byKey[key]) {
      byKey[key] = {
        nombre: nombre,
        inicialMinima: null,
        inicialSugerida: null,
        plazos: [],
      };
      order.push(key);
    }
    var cat = byKey[key];

    // Las filas de una misma categoría repiten las reglas: se toma la primera que se pueda interpretar.
    if (!cat.inicialMinima && idxMin !== -1) cat.inicialMinima = parseInitialRule_(row[idxMin]);
    if (!cat.inicialSugerida && idxSug !== -1) cat.inicialSugerida = parseInitialRule_(row[idxSug]);

    for (var t = 0; t < termCols.length; t++) {
      var meses = termCols[t].meses;
      var yaExiste = cat.plazos.some(function (p) { return p.meses === meses; });
      if (yaExiste) continue;

      var rate = parseTermRate_(row[termCols[t].col], meses);
      if (rate) cat.plazos.push({ meses: meses, factor: rate.factor, tasaMensual: rate.tasaMensual });
    }
  }

  return order.map(function (k) {
    var cat = byKey[k];
    cat.plazos.sort(function (a, b) { return a.meses - b.meses; });
    return cat;
  });
}

/** "REDONDEAR.MAS(Precio*0.20; -2)" | 0.2 | "20%" -> { pct: 0.2, digitos: -2 | null } */
function parseInitialRule_(cell) {
  if (cell === "" || cell === null || cell === undefined) return null;

  if (typeof cell === "number") {
    if (cell <= 0) return null;
    return { pct: cell > 1 ? cell / 100 : cell, digitos: null };
  }

  var text = String(cell);
  var m = text.match(/precio\s*\*\s*(\d+(?:[.,]\d+)?)/i) || text.match(/(\d+(?:[.,]\d+)?)\s*%/);
  if (!m) return null;

  var pct = parseFloat(m[1].replace(",", "."));
  if (!isFinite(pct) || pct <= 0) return null;
  if (pct > 1) pct = pct / 100;

  // Redondeo opcional: el argumento que sigue a "Precio*0.25", ej. "; -2)"
  var d = text.match(/precio\s*\*\s*\d+(?:[.,]\d+)?(?![.,\d])\s*[;,]\s*(-?\d+)\s*\)/i);
  return { pct: pct, digitos: d ? Number(d[1]) : null };
}

/** "=(1.30 ^ (1 / 18))" -> { factor: 1.30, tasaMensual: 1.30^(1/18) - 1 }. "Sin calculo"/vacío -> null */
function parseTermRate_(cell, meses) {
  if (cell === "" || cell === null || cell === undefined) return null;

  var factor = null;

  if (typeof cell === "number") {
    if (cell > 0 && cell < 1) factor = 1 + cell;       // 0.30 -> 1.30
    else if (cell > 1 && cell < 3) factor = cell;      // 1.30
  } else {
    var text = String(cell);
    if (/sin\s*c[aá]lculo/i.test(text)) return null;

    var m = text.match(/\(\s*(\d+(?:[.,]\d+)?)\s*\^/);
    if (m) {
      factor = parseFloat(m[1].replace(",", "."));
    } else {
      var mm = text.match(/(\d+(?:[.,]\d+)?)\s*%\s*mensual/i);
      if (mm) {
        var monthly = parseFloat(mm[1].replace(",", ".")) / 100;
        factor = Math.pow(1 + monthly, meses);
      }
    }
  }

  if (!factor || !isFinite(factor) || factor <= 1 || factor >= 3) return null;
  return { factor: factor, tasaMensual: Math.pow(factor, 1 / meses) - 1 };
}

/** Número desde una celda (acepta números y textos como "$12.855,00"). */
function toNumber_(v) {
  if (typeof v === "number") return isFinite(v) ? v : 0;
  var t = String(v || "").replace(/[^0-9,.\-]/g, "");
  if (!t) return 0;
  if (t.indexOf(",") !== -1) t = t.replace(/\./g, "").replace(",", "."); // formato 12.855,00
  var n = Number(t);
  return isFinite(n) ? n : 0;
}

/** Devuelve solo los nombres de la hoja "VENDEDORES" (los correos no se exponen). */
function getVendedores_() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_VENDEDORES);
  if (!sheet) return [];

  var values = sheet.getDataRange().getValues();
  if (values.length < 2) return [];

  var headers = values[0].map(function (h) {
    return String(h).trim().toLowerCase();
  });
  var idxNombre = headers.indexOf("nombre");
  if (idxNombre === -1) return [];

  var nombres = [];
  for (var i = 1; i < values.length; i++) {
    var nombre = String(values[i][idxNombre] || "").trim();
    if (nombre) nombres.push(nombre);
  }
  return nombres;
}

/** Guarda la cotización en "FUNEL DE VENTA", genera el PDF y envía el correo. */
function saveQuoteAndNotify_(data) {
  var required = ["leadName", "leadEmail", "vendedorName"];
  for (var i = 0; i < required.length; i++) {
    if (!data[required[i]]) {
      return { success: false, error: "Falta el campo obligatorio: " + required[i] };
    }
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(data.leadEmail).trim())) {
    return { success: false, error: "El email del lead no es válido." };
  }

  var fields = ["leadName", "leadPhone", "leadEmail", "vendedorName", "equipo", "categoria"];
  for (var j = 0; j < fields.length; j++) {
    if (String(data[fields[j]] || "").length > 200) {
      return { success: false, error: "El campo " + fields[j] + " es demasiado largo." };
    }
  }

  var sheet = getSheet_(SHEET_FUNEL);
  var numero;

  // Evita filas mezcladas y números de cotización repetidos si dos
  // vendedores guardan al mismo tiempo.
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    ensureFunnelHeaders_(sheet);
    numero = generateQuoteNumber_(sheet); // correlativo = fila que ocupará la nueva cotización
    appendQuoteRow_(sheet, data, numero);
  } finally {
    lock.releaseLock();
  }

  var vendedorEmail = findVendedorEmail_(data.vendedorName);

  var pdfBlob = null;
  var pdfWarning = "";
  try {
    pdfBlob = buildQuotePdfBlob_(data, numero);
  } catch (pdfErr) {
    pdfWarning = "No se pudo adjuntar el PDF de la cotización: " + pdfErr;
  }

  sendQuoteEmail_(data, vendedorEmail, pdfBlob);

  var warnings = [];
  if (!vendedorEmail) {
    warnings.push(
      'No se encontró el correo del vendedor "' +
        data.vendedorName +
        '" en la hoja "' +
        SHEET_VENDEDORES +
        '". Se envió el correo solo al lead.'
    );
  }
  if (pdfWarning) warnings.push(pdfWarning);

  return {
    success: true,
    numero: numero,
    warning: warnings.length ? warnings.join(" ") : undefined,
  };
}

function generateQuoteNumber_(sheet) {
  var correlativo = sheet.getLastRow(); // encabezado = fila 1, así que esto ya es 1-based
  var tz = Session.getScriptTimeZone();
  var fecha = Utilities.formatDate(new Date(), tz, "yyyyMMdd");
  return "COT-" + fecha + "-" + ("000" + correlativo).slice(-3);
}

function appendQuoteRow_(sheet, data, numero) {
  sheet.appendRow([
    numero,
    new Date(),
    data.vendedorName || "",
    data.leadName || "",
    data.leadPhone || "",
    data.leadEmail || "",
    data.equipo || "",
    data.categoria || "",
    Number(data.basePrice) || 0,
    Number(data.initialAmount) || 0,
    Number(data.installments) || 0,
    Number(data.monthlyPayment) || 0,
    Number(data.totalToPay) || 0,
    data.ivaFinancing === "no" ? "No" : "Sí",
    Number(data.ivaToPay) || 0,
    hasContado_(data) ? Number(data.contadoPrecio) || 0 : "",
    hasContado_(data) ? Number(data.contadoIva) || 0 : "",
    hasContado_(data) ? Number(data.contadoTotal) || 0 : "",
    Number(data.creditoIva) || 0,
    Number(data.creditoTotal) || 0,
    data.ajustado ? "Sí" : "No",
  ]);
}

function ensureFunnelHeaders_(sheet) {
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(FUNEL_HEADERS);
    return;
  }

  // Hoja ya existente con los encabezados anteriores: agrega los nuevos al final.
  var current = sheet.getLastColumn();
  if (current < FUNEL_HEADERS.length) {
    sheet
      .getRange(1, current + 1, 1, FUNEL_HEADERS.length - current)
      .setValues([FUNEL_HEADERS.slice(current)]);
  }
}

/** Busca en la hoja "VENDEDORES" el correo asociado a un nombre (sin distinguir mayúsculas/acentos). */
function findVendedorEmail_(nombreVendedor) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_VENDEDORES);
  if (!sheet) return "";

  var values = sheet.getDataRange().getValues();
  if (values.length < 2) return "";

  var headers = values[0].map(function (h) {
    return String(h).trim().toLowerCase();
  });
  var idxNombre = headers.indexOf("nombre");
  var idxEmail = headers.indexOf("email");
  if (idxNombre === -1 || idxEmail === -1) return "";

  var target = normalizeName_(nombreVendedor);

  for (var i = 1; i < values.length; i++) {
    var rowName = normalizeName_(values[i][idxNombre]);
    if (rowName === target) {
      return String(values[i][idxEmail] || "");
    }
  }

  return "";
}

function normalizeName_(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

/* ------------------------------------------------------------------ */
/* Correo                                                              */
/* ------------------------------------------------------------------ */

function sendQuoteEmail_(data, vendedorEmail, pdfBlob) {
  var subject = "Propuesta de financiamiento BNH Medical" + (data.equipo ? " - " + data.equipo : "");
  var html = buildQuoteEmailHtml_(data);

  var options = { htmlBody: html };
  if (vendedorEmail) options.cc = vendedorEmail;
  if (pdfBlob) options.attachments = [pdfBlob];

  MailApp.sendEmail(data.leadEmail, subject, "", options);
}

function buildQuoteEmailHtml_(data) {
  // Solo se acepta un logo por https (evita inyectar URLs arbitrarias en el correo)
  var logo = /^https:\/\/[^\s"'<>]+$/.test(String(data.logoUrl || ""))
    ? '<img src="' + escapeHtml_(data.logoUrl) + '" alt="BNH Medical" style="height:60px; margin-bottom:12px;">'
    : "";

  return (
    '<div style="font-family: Verdana, sans-serif; color:#111;">' +
    logo +
    '<h2 style="color:' + BRAND_COLOR + ';">Propuesta de Financiamiento — BNH Medical</h2>' +
    "<p>Estimado(a) <strong>" + escapeHtml_(data.leadName) + "</strong>,</p>" +
    "<p>Adjuntamos la cotización en PDF con el detalle completo de la propuesta. Aquí un resumen:</p>" +
    '<table style="border-collapse:collapse; width:100%; max-width:480px;">' +
    row_("Equipo", escapeHtml_(data.equipo)) +
    row_("Categoría", escapeHtml_(data.categoria)) +
    contadoEmailRows_(data) +
    row_("Base imponible", formatMoney_(data.basePrice)) +
    row_(ivaCreditoLabel_(data), formatMoney_(data.creditoIva)) +
    row_("Total (base + I.V.A.)", "<strong>" + formatMoney_(data.creditoTotal) + "</strong>") +
    row_("Monto inicial", formatMoney_(data.initialAmount)) +
    row_("Cantidad de cuotas", String(Number(data.installments) || 0)) +
    row_("Cuota mensual", "<strong>" + formatMoney_(data.monthlyPayment) + "</strong>", true) +
    row_("Total a pagar financiado", formatMoney_(data.totalToPay)) +
    "</table>" +
    '<p style="margin-top:16px;">Vendedor a cargo: <strong>' + escapeHtml_(data.vendedorName) + "</strong></p>" +
    '<p style="color:#888; font-size:12px;">Esta propuesta es una simulación comercial y puede variar según las condiciones finales de la operación.</p>' +
    "</div>"
  );
}

function ivaCreditoLabel_(data) {
  return data.ajustado ? "I.V.A. (ajustado)" : "I.V.A. (16%)";
}

function ivaContadoLabel_(data) {
  return data.ajustado ? "I.V.A. (ajustado)" : "I.V.A. (monto ÷ 1,03 × 16%)";
}

function contadoEmailRows_(data) {
  if (!hasContado_(data)) return "";
  return (
    '<tr><td colspan="2" style="padding:8px 0 2px; font-weight:bold; color:' + BRAND_COLOR + ';">De contado</td></tr>' +
    row_("Precio de contado", formatMoney_(data.contadoPrecio)) +
    row_(ivaContadoLabel_(data), formatMoney_(data.contadoIva)) +
    row_("Total de contado (base + I.V.A.)", "<strong>" + formatMoney_(data.contadoTotal) + "</strong>") +
    '<tr><td colspan="2" style="padding:12px 0 2px; font-weight:bold; color:' + BRAND_COLOR + ';">Crédito</td></tr>'
  );
}

function row_(label, value, highlight) {
  var border = highlight ? "border-top:2px solid " + BRAND_COLOR + ";" : "";
  return (
    '<tr><td style="padding:6px 0; ' + border + '">' + label + "</td>" +
    '<td style="padding:6px 0; text-align:right; ' + border + '">' + value + "</td></tr>"
  );
}

/* ------------------------------------------------------------------ */
/* PDF de la cotización ("Cotización de Servicios")                    */
/* ------------------------------------------------------------------ */

/**
 * Genera el PDF de la cotización con DocumentApp y lo devuelve como Blob.
 * No incluye RIF ni dirección del cliente (a propósito): solo nombre,
 * teléfono y correo.
 */
function buildQuotePdfBlob_(data, numero) {
  var tz = Session.getScriptTimeZone();
  var fecha = Utilities.formatDate(new Date(), tz, "dd/MM/yyyy");

  var doc = DocumentApp.create("Cotizacion " + numero);
  var docId = doc.getId();

  try {
    var body = doc.getBody();
    body.setMarginTop(28).setMarginBottom(28).setMarginLeft(40).setMarginRight(40);

    appendLogo_(body, data.logoUrl);

    var title = body.appendParagraph("Cotización de Servicios");
    title.setFontSize(22).setBold(true).setForegroundColor(DARK_COLOR);
    title.setSpacingBefore(6).setSpacingAfter(2);

    var subtitle = body.appendParagraph(EMISOR.nombre);
    subtitle.setFontSize(10).setForegroundColor("#666666").setSpacingAfter(16);

    appendClientIssuerTable_(body, data);

    var meta = body.appendParagraph("N° de cotización: " + numero + "      Fecha: " + fecha);
    meta.setFontSize(10).setForegroundColor("#333333").setSpacingBefore(12).setSpacingAfter(14);

    appendProductTable_(body, data);
    appendSummary_(body, data);
    appendFinancingDetail_(body, data);
    appendConditions_(body);
    appendFooter_(body);

    doc.saveAndClose();

    var pdfBlob = DriveApp.getFileById(docId).getAs("application/pdf");
    pdfBlob.setName("Cotizacion-" + numero + ".pdf");
    return pdfBlob;
  } finally {
    // El documento temporal solo se usa para exportar el PDF; se descarta.
    try {
      DriveApp.getFileById(docId).setTrashed(true);
    } catch (cleanupErr) {
      // Si falla el borrado no debe interrumpir el envío de la cotización.
    }
  }
}

function appendLogo_(body, logoUrl) {
  if (!/^https:\/\/[^\s"'<>]+$/.test(String(logoUrl || ""))) return;

  try {
    var imgBlob = UrlFetchApp.fetch(logoUrl).getBlob();
    var img = body.appendImage(imgBlob);
    var ratio = img.getHeight() / img.getWidth();
    img.setWidth(130);
    img.setHeight(Math.round(130 * ratio));
  } catch (err) {
    // Si no se puede descargar el logo, el PDF se genera sin imagen.
  }
}

function appendClientIssuerTable_(body, data) {
  var table = body.appendTable([["", ""]]);
  table.setBorderWidth(0);

  var row = table.getRow(0);
  fillInfoCell_(row.getCell(0), "Datos del Cliente", [
    data.leadName || "-",
    "Teléfono: " + (data.leadPhone || "-"),
    "Correo: " + (data.leadEmail || "-"),
  ]);
  fillInfoCell_(
    row.getCell(1),
    "Datos del Emisor",
    [EMISOR.nombre, "RIF: " + EMISOR.rif].concat(EMISOR.direccionLineas)
  );
}

function fillInfoCell_(cell, heading, lines) {
  cell.setWidth(250);

  var headingP = cell.getChild(0).asParagraph();
  headingP.setText(heading);
  headingP.setBold(true).setForegroundColor(BRAND_COLOR).setFontSize(11);

  for (var i = 0; i < lines.length; i++) {
    var p = cell.appendParagraph(lines[i]);
    p.setFontSize(9.5).setForegroundColor("#333333");
  }
}

function appendProductTable_(body, data) {
  var rows = [
    ["Producto", "Cantidad", "Precio", "Subtotal"],
    [
      data.equipo || "Equipo cotizado",
      "1",
      formatMoney_(data.basePrice),
      formatMoney_(data.basePrice),
    ],
  ];

  var table = body.appendTable(rows);
  table.setBorderColor("#cccccc").setBorderWidth(1);

  var headerRow = table.getRow(0);
  for (var c = 0; c < headerRow.getNumCells(); c++) {
    var cell = headerRow.getCell(c);
    cell.setBackgroundColor(BRAND_COLOR);
    var p = cell.getChild(0).asParagraph();
    p.setBold(true).setForegroundColor("#ffffff").setFontSize(10);
  }

  var dataRow = table.getRow(1);
  for (var d = 0; d < dataRow.getNumCells(); d++) {
    dataRow.getCell(d).getChild(0).asParagraph().setFontSize(10);
  }
}

function scenarioTitle_(body, text) {
  var t = body.appendParagraph(text);
  t.setAlignment(DocumentApp.HorizontalAlignment.RIGHT);
  t.setBold(true).setFontSize(12).setForegroundColor(BRAND_COLOR);
  t.setSpacingBefore(10).setSpacingAfter(2);
}

function hasContado_(data) {
  return (
    data.contadoTotal !== undefined &&
    data.contadoTotal !== null &&
    data.contadoTotal !== ""
  );
}

function appendSummary_(body, data) {
  body.appendParagraph("").setSpacingAfter(2);

  // Escenario 1: De contado (solo si el front envió los datos)
  if (hasContado_(data)) {
    scenarioTitle_(body, "DE CONTADO");
    summaryLine_(body, "Precio de contado (base)", formatMoney_(data.contadoPrecio), false);
    summaryLine_(body, ivaContadoLabel_(data), formatMoney_(data.contadoIva), false);
    summaryLine_(body, "TOTAL DE CONTADO", formatMoney_(data.contadoTotal), true);

    // Escenario 2: Crédito
    scenarioTitle_(body, "CRÉDITO");
  }

  summaryLine_(body, "Base imponible", formatMoney_(data.basePrice), false);
  summaryLine_(body, ivaCreditoLabel_(data), formatMoney_(data.creditoIva), false);
  summaryLine_(body, "TOTAL (base + I.V.A.)", formatMoney_(data.creditoTotal), true);
}

function summaryLine_(body, label, value, big) {
  var p = body.appendParagraph(label + "      " + value);
  p.setAlignment(DocumentApp.HorizontalAlignment.RIGHT);
  p.setFontSize(big ? 13 : 10.5);
  if (big) {
    p.setBold(true).setForegroundColor(BRAND_COLOR);
    p.setSpacingBefore(4);
  }
}

function appendFinancingDetail_(body, data) {
  var title = body.appendParagraph("Detalle de Financiamiento");
  title.setBold(true).setFontSize(12).setForegroundColor(BRAND_COLOR);
  title.setSpacingBefore(20).setSpacingAfter(6);

  var rows = [
    ["Categoría", data.categoria || "-"],
    ["Monto inicial", formatMoney_(data.initialAmount)],
    ["Cantidad de cuotas", String(Number(data.installments) || 0)],
    ["Cuota mensual", formatMoney_(data.monthlyPayment)],
    ["Total a pagar financiado", formatMoney_(data.totalToPay)],
  ];

  var table = body.appendTable(rows);
  table.setBorderWidth(0);

  for (var r = 0; r < table.getNumRows(); r++) {
    var row = table.getRow(r);
    row.getCell(0).getChild(0).asParagraph().setFontSize(10).setForegroundColor("#333333");
    var valueP = row.getCell(1).getChild(0).asParagraph();
    valueP.setFontSize(10).setBold(true);
  }
}

function appendConditions_(body) {
  var title = body.appendParagraph("CONDICIONES");
  title.setBold(true).setFontSize(11).setForegroundColor(BRAND_COLOR);
  title.setSpacingBefore(20).setSpacingAfter(4);

  var lines = [
    "Vigencia de la cotización: 7 días naturales.",
    "Tiempo estimado de entrega: 5 días hábiles a partir del pago de la inicial.",
    "Incluye: Garantía, instalación y capacitación (según equipo).",
    "El monto de las cuotas puede ajustarse según la tasa BCV vigente al momento del pago.",
  ];

  for (var i = 0; i < lines.length; i++) {
    var p = body.appendParagraph("• " + lines[i]);
    p.setFontSize(9.5).setForegroundColor("#333333").setSpacingAfter(2);
  }
}

function appendFooter_(body) {
  var footer = body.appendParagraph(
    EMISOR.web + "   ·   " + EMISOR.instagram + "   ·   " + EMISOR.direccionLineas.join(", ")
  );
  footer.setFontSize(8.5).setForegroundColor("#888888").setSpacingBefore(22);
}

function formatMoney_(n) {
  var value = Number(n) || 0;
  return "$" + value.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/* ------------------------------------------------------------------ */
/* Utilidades                                                          */
/* ------------------------------------------------------------------ */

function escapeHtml_(str) {
  return String(str || "").replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });
}

function getSheet_(name) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(name);
  if (!sheet) throw new Error('No se encontró la hoja "' + name + '".');
  return sheet;
}

function jsonResponse_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(
    ContentService.MimeType.JSON
  );
}
