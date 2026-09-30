// ============================================================
// JNI TRAVEL OCR
// OCR.SPACE ENGINE 2
// HYBRID DOCUMENT PARSER
//
// KTP
// KK
// PASSPORT
//
// STRATEGI:
// 1. OCR raw text
// 2. OCR coordinates
// 3. Pattern parser
// 4. Layout parser
// 5. Validation
//
// JANGAN menganggap teks terdekat = nilai.
// Setiap field punya aturan validasi sendiri.
// ============================================================

module.exports = async function handler(req, res) {

  if (req.method !== "POST") {
    return res.status(405).json({
      ok: false,
      error: "Method not allowed",
      method: req.method
    });
  }

  try {

    // ========================================================
    // API KEY
    // ========================================================

    const apiKey =
      process.env.OCR_SPACE_API_KEY;

    if (!apiKey) {
      return res.status(500).json({
        ok: false,
        error: "OCR_SPACE_API_KEY belum tersedia."
      });
    }

    // ========================================================
    // INPUT
    // ========================================================

    const {
      documentType,
      fileName,
      mimeType,
      dataUrl
    } = req.body || {};

    if (!dataUrl) {
      return res.status(400).json({
        ok: false,
        error: "File tidak ditemukan."
      });
    }

    const allowedTypes = [
      "image/jpeg",
      "image/png",
      "image/webp",
      "application/pdf"
    ];

    if (!allowedTypes.includes(mimeType)) {
      return res.status(400).json({
        ok: false,
        error:
          "Format tidak didukung. Gunakan JPG, PNG, WEBP atau PDF."
      });
    }

    // ========================================================
    // DATA URL
    // ========================================================

    const match =
      dataUrl.match(
        /^data:([^;]+);base64,(.+)$/
      );

    if (!match) {
      return res.status(400).json({
        ok: false,
        error: "Data file tidak valid."
      });
    }

    const detectedMime =
      match[1];

    const base64Data =
      match[2];

    // ========================================================
    // 1 MB FREE LIMIT
    // ========================================================

    const fileSizeBytes =
      Math.ceil(
        (base64Data.length * 3) / 4
      );

    if (
      fileSizeBytes >
      1024 * 1024
    ) {
      return res.status(400).json({
        ok: false,
        error:
          "File lebih dari 1 MB. Kompres file terlebih dahulu."
      });
    }

    // ========================================================
    // OCR.SPACE
    // ========================================================

    const form =
      new FormData();

    form.append(
      "base64Image",
      `data:${detectedMime};base64,${base64Data}`
    );

    // Engine 2
    form.append(
      "OCREngine",
      "2"
    );

    // AUTO lebih tepat untuk dokumen campuran
    form.append(
      "language",
      "auto"
    );

    // Kita butuh koordinat untuk fallback layout
    form.append(
      "isOverlayRequired",
      "true"
    );

    form.append(
      "detectOrientation",
      "true"
    );

    form.append(
      "scale",
      "true"
    );

    // Table mode terutama membantu KK
    if (
      String(documentType || "")
        .toLowerCase()
        .includes("kk")
    ) {
      form.append(
        "isTable",
        "true"
      );
    }

    // ========================================================
    // CALL OCR
    // ========================================================

    const response =
      await fetch(
        "https://api.ocr.space/parse/image",
        {
          method: "POST",

          headers: {
            apikey: apiKey
          },

          body: form
        }
      );

    const raw =
      await response.text();

    let result;

    try {
      result =
        JSON.parse(raw);
    } catch {
      return res.status(502).json({
        ok: false,
        error:
          "OCR.space mengembalikan response tidak valid.",
        httpStatus:
          response.status
      });
    }

    if (!response.ok) {
      return res.status(502).json({
        ok: false,
        error:
          "OCR.space API error.",
        httpStatus:
          response.status,
        details:
          result
      });
    }

    if (
      result.IsErroredOnProcessing
    ) {
      return res.status(422).json({
        ok: false,
        error:
          Array.isArray(
            result.ErrorMessage
          )
            ? result.ErrorMessage.join(" ")
            : (
                result.ErrorMessage ||
                "OCR gagal."
              ),
        details:
          result.ErrorDetails ||
          null
      });
    }

    const parsedResults =
      Array.isArray(
        result.ParsedResults
      )
        ? result.ParsedResults
        : [];

    if (!parsedResults.length) {
      return res.status(422).json({
        ok: false,
        error:
          "OCR tidak menghasilkan halaman."
      });
    }

    // ========================================================
    // RAW TEXT
    // ========================================================

    const rawText =
      parsedResults
        .map(
          x =>
            x?.ParsedText ||
            ""
        )
        .filter(Boolean)
        .join("\n");

    if (!rawText.trim()) {
      return res.status(422).json({
        ok: false,
        error:
          "OCR selesai tetapi teks tidak ditemukan."
      });
    }

    // ========================================================
    // OVERLAY
    // ========================================================

    const overlay =
      parsedResults
        .map(
          x =>
            x?.TextOverlay ||
            null
        )
        .filter(Boolean);

    // ========================================================
    // DETECT TYPE
    // ========================================================

    const type =
      detectDocumentType(
        documentType,
        rawText
      );

    // ========================================================
    // NORMALIZED LINES
    // ========================================================

    const lines =
      getLines(
        overlay
      );

    const textLines =
      getTextLines(
        rawText
      );

    // ========================================================
    // PARSER
    // ========================================================

    let data;

    if (type === "ktp") {

      data =
        parseKTP(
          rawText,
          textLines,
          lines
        );

    }

    else if (
      type === "passport"
    ) {

      data =
        parsePassport(
          rawText,
          textLines,
          lines
        );

    }

    else if (
      type === "kk"
    ) {

      data =
        parseKK(
          rawText,
          textLines,
          lines
        );

    }

    else {

      data =
        parseGeneric(
          rawText
        );

    }

    // ========================================================
    // VALIDATION
    // ========================================================

    const validation =
      validate(
        type,
        data
      );

    // ========================================================
    // USAGE INFO
    // ========================================================

    return res.status(200).json({

      ok: true,

      fileName:
        fileName || null,

      documentType:
        type,

      data,

      validation,

      rawText,

      // untuk debugging
      overlay,

      ocr: {

        engine: 2,

        language:
          "auto",

        exitCode:
          result.OCRExitCode ||
          null,

        processingTimeMs:
          result.ProcessingTimeInMilliseconds ||
          null,

        pages:
          parsedResults.length

      }

    });

  }

  catch (error) {

    console.error(
      "JNI OCR ERROR:",
      error
    );

    return res.status(500).json({
      ok: false,
      error:
        "Terjadi error pada server OCR.",
      details:
        error?.message ||
        String(error)
    });

  }

};


// ============================================================
// DOCUMENT TYPE
// ============================================================

function detectDocumentType(
  input,
  text
) {

  const i =
    String(input || "")
      .toLowerCase();

  if (
    i.includes("ktp")
  ) {
    return "ktp";
  }

  if (
    i.includes("kk") ||
    i.includes("keluarga")
  ) {
    return "kk";
  }

  if (
    i.includes("passport") ||
    i.includes("paspor")
  ) {
    return "passport";
  }

  const t =
    normalize(
      text
    );

  if (
    t.includes(
      "KARTU KELUARGA"
    )
  ) {
    return "kk";
  }

  if (
    t.includes(
      "PASSPORT"
    ) ||
    t.includes(
      "PASPOR"
    )
  ) {
    return "passport";
  }

  if (
    t.includes("NIK") &&
    (
      t.includes(
        "TEMPAT"
      ) ||
      t.includes(
        "JENIS KELAMIN"
      )
    )
  ) {
    return "ktp";
  }

  return "unknown";
}


// ============================================================
// BASIC
// ============================================================

function normalize(
  value
) {

  return String(
    value || ""
  )
    .toUpperCase()
    .replace(
      /\s+/g,
      " "
    )
    .trim();

}


function clean(
  value
) {

  if (
    value === null ||
    value === undefined
  ) {
    return null;
  }

  const v =
    String(value)
      .replace(
        /\s+/g,
        " "
      )
      .replace(
        /^[\s:;,\-|–—]+/,
        ""
      )
      .replace(
        /[\s:;,\-|–—]+$/,
        ""
      )
      .trim();

  return v || null;

}


function getTextLines(
  text
) {

  return String(
    text || ""
  )
    .split(/\r?\n/)
    .map(
      x =>
        x
          .replace(
            /\t+/g,
            " "
          )
          .replace(
            /\s+/g,
            " "
          )
          .trim()
    )
    .filter(Boolean);

}


// ============================================================
// OCR OVERLAY
// ============================================================

function getLines(
  overlay
) {

  const result = [];

  for (
    const page of overlay || []
  ) {

    for (
      const line of
      page?.Lines || []
    ) {

      const words =
        Array.isArray(
          line?.Words
        )
          ? line.Words
          : [];

      if (!words.length) {
        continue;
      }

      const sorted =
        [...words]
          .sort(
            (a, b) =>
              Number(
                a.Left || 0
              ) -
              Number(
                b.Left || 0
              )
          );

      const text =
        sorted
          .map(
            w =>
              String(
                w.WordText || ""
              )
          )
          .join(" ")
          .trim();

      if (!text) {
        continue;
      }

      const left =
        Math.min(
          ...sorted.map(
            w =>
              Number(
                w.Left || 0
              )
          )
        );

      const right =
        Math.max(
          ...sorted.map(
            w =>
              Number(
                w.Left || 0
              ) +
              Number(
                w.Width || 0
              )
          )
        );

      const top =
        Math.min(
          ...sorted.map(
            w =>
              Number(
                w.Top || 0
              )
          )
        );

      const bottom =
        Math.max(
          ...sorted.map(
            w =>
              Number(
                w.Top || 0
              ) +
              Number(
                w.Height || 0
              )
          )
        );

      result.push({

        text,

        words:
          sorted,

        left,

        right,

        top,

        bottom,

        centerX:
          (left + right) / 2,

        centerY:
          (top + bottom) / 2

      });

    }

  }

  return result.sort(
    (a, b) =>
      a.top - b.top ||
      a.left - b.left
  );

}


// ============================================================
// FIND LINE
// ============================================================

function findLine(
  lines,
  labels
) {

  const arr =
    Array.isArray(labels)
      ? labels
      : [labels];

  return lines.find(
    line => {

      const t =
        normalize(
          line.text
        );

      return arr.some(
        label =>
          t.includes(
            normalize(label)
          )
      );

    }
  );

}


// ============================================================
// FIND TEXT LINE
// ============================================================

function findTextLineIndex(
  textLines,
  labels
) {

  const arr =
    Array.isArray(labels)
      ? labels
      : [labels];

  for (
    let i = 0;
    i < textLines.length;
    i++
  ) {

    const t =
      normalize(
        textLines[i]
      );

    if (
      arr.some(
        label =>
          t.includes(
            normalize(label)
          )
      )
    ) {
      return i;
    }

  }

  return -1;

}


// ============================================================
// REMOVE LABEL
// ============================================================

function removeLabels(
  value,
  labels
) {

  if (!value) {
    return null;
  }

  let v =
    clean(value);

  for (
    const label of
    labels || []
  ) {

    const escaped =
      String(label)
        .replace(
          /[.*+?^${}()|[\]\\]/g,
          "\\$&"
        );

    v =
      v.replace(
        new RegExp(
          escaped,
          "ig"
        ),
        ""
      );

  }

  return clean(v);

}


// ============================================================
// DATE DETECTOR
// ============================================================

function isDate(
  value
) {

  if (!value) {
    return false;
  }

  return (
    /\b\d{1,2}[\/.\-]\d{1,2}[\/.\-]\d{2,4}\b/.test(
      value
    ) ||

    /\b\d{1,2}\s+(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)[A-Z]*\s+\d{4}\b/i.test(
      value
    )
  );

}


// ============================================================
// DATE EXTRACT
// ============================================================

function extractDate(
  value
) {

  if (!value) {
    return null;
  }

  const numeric =
    String(value).match(
      /\b\d{1,2}[\/.\-]\d{1,2}[\/.\-]\d{2,4}\b/
    );

  if (numeric) {
    return numeric[0];
  }

  const textDate =
    String(value).match(
      /\b\d{1,2}\s+(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)[A-Z]*\s+\d{4}\b/i
    );

  if (textDate) {
    return clean(
      textDate[0]
    );
  }

  return null;

}


// ============================================================
// DATE INVALID AS PLACE
// ============================================================

function isObviouslyNotPlace(
  value
) {

  if (!value) {
    return true;
  }

  if (
    isDate(value)
  ) {
    return true;
  }

  if (
    /^\d[\d\s.,\/-]*$/.test(
      value
    )
  ) {
    return true;
  }

  const bad =
    [
      "DATE",
      "DATE OF",
      "EXPIRY",
      "EXPIRATION",
      "ISSUE",
      "ISSUED",
      "PASSPORT",
      "SEX",
      "NATIONALITY"
    ];

  const u =
    normalize(value);

  return bad.some(
    x =>
      u === x ||
      u.includes(x)
  );

}


// ============================================================
// KTP VALUE FROM TEXT
//
// KTP sering OCR menjadi:
//
// Nama
// NUR FADIYAH
//
// bukan:
//
// Nama : NUR FADIYAH
//
// Jadi kita cari:
// 1. value pada baris yang sama
// 2. baris berikutnya
// 3. beberapa baris berikutnya
// ============================================================

function ktpTextValue(
  textLines,
  labels,
  options = {}
) {

  const index =
    findTextLineIndex(
      textLines,
      labels
    );

  if (index < 0) {
    return null;
  }

  const current =
    textLines[index];

  const normalizedCurrent =
    normalize(current);

  // ========================================================
  // SAME LINE
  // ========================================================

  for (
    const label of labels
  ) {

    const pos =
      normalizedCurrent.indexOf(
        normalize(label)
      );

    if (pos >= 0) {

      const raw =
        current.substring(
          pos +
          String(label).length
        );

      const value =
        clean(
          raw
        );

      if (
        value &&
        normalize(value) !==
        normalize(label)
      ) {
        return value;
      }

    }

  }

  // ========================================================
  // NEXT LINES
  // ========================================================

  for (
    let step = 1;
    step <= 3;
    step++
  ) {

    const candidate =
      textLines[
        index + step
      ];

    if (!candidate) {
      break;
    }

    // Jangan ambil label field berikutnya
    if (
      isKTPLabel(
        candidate
      )
    ) {
      continue;
    }

    const value =
      clean(candidate);

    if (!value) {
      continue;
    }

    return value;

  }

  return null;

}


// ============================================================
// KTP LABEL
// ============================================================

function isKTPLabel(
  value
) {

  const u =
    normalize(value);

  const labels = [

    "NIK",
    "NAMA",
    "TEMPAT/TGL LAHIR",
    "TEMPAT / TGL LAHIR",
    "JENIS KELAMIN",
    "ALAMAT",
    "RT/RW",
    "KEL/DESA",
    "KELURAHAN/DESA",
    "KECAMATAN",
    "AGAMA",
    "STATUS PERKAWINAN",
    "PEKERJAAN",
    "KEWARGANEGARAAN",
    "BERLAKU HINGGA"

  ];

  return labels.some(
    x =>
      u === normalize(x)
  );

}


// ============================================================
// KTP
// ============================================================

function parseKTP(
  rawText,
  textLines,
  lines
) {

  // ========================================================
  // NIK
  // ========================================================

  let nik =
    null;

  const nikMatch =
    String(rawText).match(
      /\b\d{16}\b/
    );

  if (nikMatch) {
    nik =
      nikMatch[0];
  }

  // ========================================================
  // NAMA
  // ========================================================

  let nama =
    ktpTextValue(
      textLines,
      ["NAMA"]
    );

  // fallback overlay
  if (!nama) {

    nama =
      layoutNextValue(
        lines,
        [
          "NAMA"
        ],
        {
          maxY: 100
        }
      );

  }

  // ========================================================
  // TEMPAT/TGL LAHIR
  // ========================================================

  let ttl =
    ktpTextValue(
      textLines,
      [
        "TEMPAT/TGL LAHIR",
        "TEMPAT / TGL LAHIR",
        "TEMPAT/TGL. LAHIR",
        "TEMPAT / TGL. LAHIR"
      ]
    );

  let tempatLahir =
    null;

  let tanggalLahir =
    null;

  if (ttl) {

    const d =
      extractDate(
        ttl
      );

    if (d) {

      tanggalLahir =
        d;

      tempatLahir =
        clean(
          ttl.replace(
            d,
            ""
          )
        );

    }

    else {

      tempatLahir =
        ttl;

    }

  }

  // fallback khusus: cari baris tanggal
  if (!tanggalLahir) {

    const ttlIndex =
      findTextLineIndex(
        textLines,
        [
          "TEMPAT/TGL LAHIR",
          "TEMPAT / TGL LAHIR",
          "TEMPAT/TGL. LAHIR"
        ]
      );

    if (
      ttlIndex >= 0
    ) {

      for (
        let i =
          ttlIndex + 1;
        i <
        Math.min(
          textLines.length,
          ttlIndex + 4
        );
        i++
      ) {

        const d =
          extractDate(
            textLines[i]
          );

        if (d) {

          tanggalLahir =
            d;

          const before =
            textLines[i]
              .replace(
                d,
                ""
              );

          if (
            !isKTPLabel(
              before
            )
          ) {
            tempatLahir =
              clean(
                before
              );
          }

          break;

        }

      }

    }

  }

  // ========================================================
  // JENIS KELAMIN
  // ========================================================

  let jenisKelamin =
    ktpTextValue(
      textLines,
      ["JENIS KELAMIN"]
    );

  if (
    jenisKelamin
  ) {

    const u =
      normalize(
        jenisKelamin
      );

    if (
      u.includes(
        "LAKI"
      )
    ) {
      jenisKelamin =
        "LAKI-LAKI";
    }

    else if (
      u.includes(
        "PEREMPUAN"
      )
    ) {
      jenisKelamin =
        "PEREMPUAN";
    }

  }

  // ========================================================
  // ALAMAT
  // ========================================================

  const alamat =
    ktpTextValue(
      textLines,
      ["ALAMAT"]
    );

  // ========================================================
  // RT/RW
  // ========================================================

  const rtRw =
    ktpTextValue(
      textLines,
      ["RT/RW"]
    );

  // ========================================================
  // KELURAHAN
  // ========================================================

  const kelurahan =
    ktpTextValue(
      textLines,
      [
        "KEL/DESA",
        "KELURAHAN/DESA",
        "KEL DESA"
      ]
    );

  // ========================================================
  // KECAMATAN
  // ========================================================

  const kecamatan =
    ktpTextValue(
      textLines,
      ["KECAMATAN"]
    );

  // ========================================================
  // STATUS
  // ========================================================

  const status =
    ktpTextValue(
      textLines,
      [
        "STATUS PERKAWINAN"
      ]
    );

  // ========================================================
  // PEKERJAAN
  // ========================================================

  const pekerjaan =
    ktpTextValue(
      textLines,
      ["PEKERJAAN"]
    );

  // ========================================================
  // KEWARGANEGARAAN
  // ========================================================

  const kewarganegaraan =
    ktpTextValue(
      textLines,
      ["KEWARGANEGARAAN"]
    );

  return {

    document_type:
      "ktp",

    nik,

    nama,

    tempat_lahir:
      tempatLahir,

    tanggal_lahir:
      tanggalLahir,

    jenis_kelamin:
      jenisKelamin,

    alamat,

    rt_rw:
      rtRw,

    kelurahan_desa:
      kelurahan,

    kecamatan,

    status_perkawinan:
      status,

    pekerjaan,

    kewarganegaraan

  };

}


// ============================================================
// LAYOUT NEXT VALUE
// ============================================================

function layoutNextValue(
  lines,
  labels,
  options = {}
) {

  const label =
    findLine(
      lines,
      labels
    );

  if (!label) {
    return null;
  }

  const candidates =
    lines
      .filter(
        line => {

          if (
            line === label
          ) {
            return false;
          }

          const dy =
            line.top -
            label.bottom;

          if (
            dy < 0 ||
            dy >
            (options.maxY ?? 100)
          ) {
            return false;
          }

          return true;

        }
      )
      .sort(
        (a, b) =>
          (
            a.top -
            label.bottom
          ) -
          (
            b.top -
            label.bottom
          )
      );

  for (
    const candidate of candidates
  ) {

    if (
      !isKTPLabel(
        candidate.text
      )
    ) {
      return clean(
        candidate.text
      );
    }

  }

  return null;

}


// ============================================================
// PASSPORT LABELS
// ============================================================

const PASSPORT_LABELS = [

  "JENIS",
  "TYPE",

  "KODE NEGARA",
  "COUNTRY CODE",

  "NO. PASPOR",
  "NO PASPOR",
  "PASSPORT NO",
  "PASSPORT NUMBER",

  "NAMA LENGKAP",
  "FULL NAME",

  "KEWARGANEGARAAN",
  "NATIONALITY",

  "TGL. LAHIR",
  "TGL LAHIR",
  "DATE OF BIRTH",

  "KELAMIN",
  "SEX",

  "TEMPAT LAHIR",
  "PLACE OF BIRTH",

  "TGL. PENGELUARAN",
  "TGL PENGELUARAN",
  "DATE OF ISSUE",

  "TGL. HABIS BERLAKU",
  "TGL HABIS BERLAKU",
  "DATE OF EXPIRY",

  "NO. REG.",
  "NO REG",

  "KANTOR YANG MENGELUARKAN",
  "ISSUING OFFICE",
  "ISSUING AUTHORITY"

];


// ============================================================
// PASSPORT LABEL CHECK
// ============================================================

function isPassportLabel(
  value
) {

  const u =
    normalize(
      value
    );

  return PASSPORT_LABELS.some(
    label =>
      u ===
      normalize(label)
  );

}


// ============================================================
// PASSPORT TEXT VALUE
//
// Prinsip utama:
// Cari label.
// Ambil baris berikutnya.
// Tapi kandidat harus lolos tipe field.
// ============================================================

function passportTextValue(
  textLines,
  labels,
  validator
) {

  const index =
    findTextLineIndex(
      textLines,
      labels
    );

  if (
    index < 0
  ) {
    return null;
  }

  // same line
  const current =
    textLines[index];

  for (
    const label of labels
  ) {

    const pos =
      normalize(current)
        .indexOf(
          normalize(label)
        );

    if (pos >= 0) {

      const raw =
        current.substring(
          pos +
          String(label).length
        );

      const value =
        clean(
          raw
        );

      if (
        value &&
        !isPassportLabel(
          value
        ) &&
        (!validator ||
          validator(value))
      ) {
        return value;
      }

    }

  }

  // next lines
  for (
    let step = 1;
    step <= 4;
    step++
  ) {

    const candidate =
      textLines[
        index + step
      ];

    if (!candidate) {
      break;
    }

    if (
      isPassportLabel(
        candidate
      )
    ) {
      continue;
    }

    const value =
      clean(
        candidate
      );

    if (
      !value
    ) {
      continue;
    }

    if (
      validator &&
      !validator(value)
    ) {
      continue;
    }

    return value;

  }

  return null;

}


// ============================================================
// PASSPORT VALIDATORS
// ============================================================

function validPassportName(
  value
) {

  if (!value) {
    return false;
  }

  if (
    isDate(value)
  ) {
    return false;
  }

  if (
    /FULL NAME|NAMA LENGKAP|PLACE OF BIRTH|SEX|NATIONALITY/i.test(
      value
    )
  ) {
    return false;
  }

  return (
    /[A-Z]/i.test(value)
  );

}


function validNationality(
  value
) {

  if (!value) {
    return false;
  }

  if (
    isDate(value)
  ) {
    return false;
  }

  const u =
    normalize(
      value
    );

  // negara / kode negara
  if (
    /\bIDN\b/.test(u) ||
    /\bINDONESIA\b/.test(u)
  ) {
    return true;
  }

  if (
    /REPUBLIC|REPUBLIK|INDONESIAN|WARGA NEGARA/i.test(
      u
    )
  ) {
    return true;
  }

  // Jangan terima kalimat legal/template
  if (
    /DIATUR|UNDANG|UNDANG UNDANG|PERATURAN|REGULATION|LAW/i.test(
      u
    )
  ) {
    return false;
  }

  return (
    u.length >= 2 &&
    u.length <= 30
  );

}


function validPlace(
  value
) {

  return (
    !!value &&
    !isObviouslyNotPlace(
      value
    ) &&
    !/PLACE OF BIRTH|TEMPAT LAHIR/i.test(
      value
    )
  );

}


function validSex(
  value
) {

  if (!value) {
    return false;
  }

  const u =
    normalize(
      value
    );

  return (
    u === "M" ||
    u === "F" ||
    u === "P" ||
    u === "L" ||
    u === "MALE" ||
    u === "FEMALE" ||
    u.includes("MALE") ||
    u.includes("FEMALE")
  );

}


function validDate(
  value
) {

  return isDate(
    value
  );

}


function validPassportNumber(
  value
) {

  if (!value) {
    return false;
  }

  const v =
    value
      .replace(
        /[^A-Z0-9]/gi,
        ""
      )
      .toUpperCase();

  return (
    /^[A-Z0-9]{7,9}$/.test(
      v
    ) &&
    !/DATE|PASSPORT|NUMBER/.test(
      v
    )
  );

}


// ============================================================
// PASSPORT
// ============================================================

function parsePassport(
  rawText,
  textLines,
  lines
) {

  // ========================================================
  // NOMOR PASSPORT
  // ========================================================

  let nomorPassport =
    passportTextValue(
      textLines,
      [
        "NO. PASPOR",
        "NO PASPOR",
        "PASSPORT NO",
        "PASSPORT NUMBER"
      ],
      validPassportNumber
    );

  // fallback
  if (!nomorPassport) {

    const matches =
      String(rawText).match(
        /\b[A-Z]\d{7}\b/gi
      ) || [];

    if (
      matches.length
    ) {
      nomorPassport =
        matches[0];
    }

  }

  if (
    nomorPassport
  ) {

    nomorPassport =
      nomorPassport
        .replace(
          /[^A-Z0-9]/gi,
          ""
        )
        .toUpperCase();

  }

  // ========================================================
  // NAMA
  // ========================================================

  let nama =
    passportTextValue(
      textLines,
      [
        "NAMA LENGKAP",
        "FULL NAME"
      ],
      validPassportName
    );

  // ========================================================
  // NATIONALITY
  // ========================================================

  let nationality =
    passportTextValue(
      textLines,
      [
        "KEWARGANEGARAAN",
        "NATIONALITY"
      ],
      validNationality
    );

  // ========================================================
  // TANGGAL LAHIR
  // ========================================================

  let tanggalLahir =
    passportTextValue(
      textLines,
      [
        "TGL. LAHIR",
        "TGL LAHIR",
        "DATE OF BIRTH"
      ],
      validDate
    );

  tanggalLahir =
    extractDate(
      tanggalLahir
    );

  // ========================================================
  // TEMPAT LAHIR
  // ========================================================

  let tempatLahir =
    passportTextValue(
      textLines,
      [
        "TEMPAT LAHIR",
        "PLACE OF BIRTH"
      ],
      validPlace
    );

  // ========================================================
  // SEX
  // ========================================================

  let jenisKelamin =
    passportTextValue(
      textLines,
      [
        "KELAMIN",
        "SEX"
      ],
      validSex
    );

  if (
    jenisKelamin
  ) {

    const u =
      normalize(
        jenisKelamin
      );

    if (
      u === "P" ||
      u === "M" ||
      u === "L" ||
      u.includes("MALE")
    ) {
      jenisKelamin =
        "M";
    }

    if (
      u === "F" ||
      u === "PEREMPUAN" ||
      u.includes("FEMALE")
    ) {
      jenisKelamin =
        "F";
    }

  }

  // ========================================================
  // TANGGAL TERBIT
  // ========================================================

  let tanggalTerbit =
    passportTextValue(
      textLines,
      [
        "TGL. PENGELUARAN",
        "TGL PENGELUARAN",
        "DATE OF ISSUE"
      ],
      validDate
    );

  tanggalTerbit =
    extractDate(
      tanggalTerbit
    );

  // ========================================================
  // EXPIRED
  // ========================================================

  let expiryDate =
    passportTextValue(
      textLines,
      [
        "TGL. HABIS BERLAKU",
        "TGL HABIS BERLAKU",
        "DATE OF EXPIRY"
      ],
      validDate
    );

  expiryDate =
    extractDate(
      expiryDate
    );

  // ========================================================
  // ISSUING OFFICE
  // ========================================================

  let issuingAuthority =
    passportTextValue(
      textLines,
      [
        "KANTOR YANG MENGELUARKAN",
        "ISSUING OFFICE",
        "ISSUING AUTHORITY"
      ],
      value =>
        !!value &&
        !isDate(value) &&
        !isPassportLabel(value) &&
        value.length >= 2
    );

  // ========================================================
  // MRZ
  // ========================================================

  const mrz =
    extractMRZ(
      rawText,
      textLines
    );

  const mrzData =
    parseMRZ(
      mrz
    );

  // ========================================================
  // MRZ FALLBACK
  // ========================================================

  if (
    mrzData
  ) {

    if (
      !nomorPassport &&
      mrzData.passport_number
    ) {
      nomorPassport =
        mrzData.passport_number;
    }

    if (
      !nationality &&
      mrzData.nationality
    ) {
      nationality =
        mrzData.nationality;
    }

    if (
      !jenisKelamin &&
      mrzData.sex
    ) {
      jenisKelamin =
        mrzData.sex;
    }

  }

  // ========================================================
  // FINAL SAFETY
  // ========================================================

  if (
    tempatLahir &&
    isDate(
      tempatLahir
    )
  ) {
    tempatLahir =
      null;
  }

  if (
    nationality &&
    /DIATUR|UNDANG|PERATURAN/i.test(
      nationality
    )
  ) {
    nationality =
      null;
  }

  return {

    document_type:
      "passport",

    nomor_passport:
      nomorPassport,

    nama,

    nationality,

    tanggal_lahir:
      tanggalLahir,

    tempat_lahir:
      tempatLahir,

    jenis_kelamin:
      jenisKelamin,

    tanggal_terbit:
      tanggalTerbit,

    expiry_date:
      expiryDate,

    issuing_authority:
      issuingAuthority,

    mrz,

    mrz_data:
      mrzData

  };

}


// ============================================================
// MRZ
// ============================================================

function extractMRZ(
  rawText,
  textLines
) {

  const candidates =
    textLines
      .map(
        line =>
          line
            .replace(
              /\s+/g,
              ""
            )
            .toUpperCase()
      )
      .filter(
        line => {

          const chevrons =
            (
              line.match(
                /</g
              ) || []
            ).length;

          return (
            line.length >= 25 &&
            (
              chevrons >= 2 ||
              /^P[<A-Z]/.test(line)
            )
          );

        }
      );

  if (
    candidates.length >= 2
  ) {

    return candidates
      .slice(-2)
      .join("\n");

  }

  // fallback dari raw text
  const rawLines =
    String(rawText)
      .split(/\r?\n/)
      .map(
        x =>
          x
            .replace(
              /\s+/g,
              ""
            )
            .toUpperCase()
      )
      .filter(Boolean);

  const rawCandidates =
    rawLines.filter(
      line => {

        const c =
          (
            line.match(
              /</g
            ) || []
          ).length;

        return (
          line.length >= 25 &&
          c >= 2
        );

      }
    );

  if (
    rawCandidates.length >= 2
  ) {

    return rawCandidates
      .slice(-2)
      .join("\n");

  }

  return null;

}


// ============================================================
// MRZ PARSER
// ============================================================

function parseMRZ(
  mrz
) {

  if (!mrz) {
    return null;
  }

  const lines =
    mrz
      .split("\n")
      .map(
        x =>
          x
            .replace(
              /\s/g,
              ""
            )
            .toUpperCase()
      )
      .filter(Boolean);

  if (
    lines.length < 2
  ) {
    return null;
  }

  const l1 =
    lines[0];

  const l2 =
    lines[1];

  const result = {
    raw: mrz
  };

  if (
    l1.length >= 5
  ) {

    result.document_type =
      l1[0];

    result.country =
      l1.substring(
        2,
        5
      );

    const namePart =
      l1.substring(
        5
      );

    const parts =
      namePart.split(
        "<<"
      );

    result.surname =
      clean(
        (
          parts[0] ||
          ""
        ).replace(
          /</g,
          " "
        )
      );

    result.given_names =
      clean(
        (
          parts[1] ||
          ""
        ).replace(
          /</g,
          " "
        )
      );

  }

  if (
    l2.length >= 27
  ) {

    result.passport_number =
      l2
        .substring(
          0,
          9
        )
        .replace(
          /</g,
          ""
        );

    result.nationality =
      l2.substring(
        10,
        13
      );

    result.birth_date =
      l2.substring(
        13,
        19
      );

    result.sex =
      l2.substring(
        20,
        21
      );

    result.expiry_date =
      l2.substring(
        21,
        27
      );

  }

  return result;

}


// ============================================================
// KK
// ============================================================

function parseKK(
  rawText,
  textLines,
  lines
) {

  const all16 =
    String(rawText).match(
      /\b\d{16}\b/g
    ) || [];

  const noKK =
    all16[0] ||
    null;

  const rows = [];

  // ========================================================
  // Cari setiap NIK
  // ========================================================

  for (
    let i = 0;
    i < textLines.length;
    i++
  ) {

    const line =
      textLines[i];

    const match =
      line.match(
        /\b\d{16}\b/
      );

    if (!match) {
      continue;
    }

    const nik =
      match[0];

    let nama =
      null;

    let namaAyah =
      null;

    // ------------------------------------------------------
    // Cari beberapa baris sekitar NIK
    // ------------------------------------------------------

    const nearby =
      textLines.slice(
        Math.max(
          0,
          i - 1
        ),
        Math.min(
          textLines.length,
          i + 4
        )
      );

    // nama:
    // pilih teks non-label/non-NIK
    for (
      const candidate of nearby
    ) {

      if (
        candidate === line
      ) {
        continue;
      }

      if (
        /\b\d{16}\b/.test(
          candidate
        )
      ) {
        continue;
      }

      if (
        isKKHeader(
          candidate
        )
      ) {
        continue;
      }

      if (
        !nama &&
        /[A-Z]/i.test(
          candidate
        )
      ) {

        nama =
          clean(
            candidate
          );

        break;

      }

    }

    rows.push({

      nik,

      nama,

      // Jangan pernah menebak.
      // Nama Ayah harus berasal dari kolom Nama Ayah.
      nama_ayah:
        namaAyah

    });

  }

  const unique =
    new Map();

  for (
    const row of rows
  ) {

    if (
      !unique.has(
        row.nik
      )
    ) {

      unique.set(
        row.nik,
        row
      );

    }

  }

  return {

    document_type:
      "kk",

    no_kk:
      noKK,

    members:
      Array.from(
        unique.values()
      )

  };

}


// ============================================================
// KK HEADER
// ============================================================

function isKKHeader(
  value
) {

  const u =
    normalize(
      value
    );

  return (
    u.includes("NIK") ||
    u.includes("NAMA AYAH") ||
    u.includes("NAMA IBU") ||
    u.includes("STATUS PERKAWINAN") ||
    u.includes("HUBUNGAN DALAM KELUARGA")
  );

}


// ============================================================
// GENERIC
// ============================================================

function parseGeneric(
  rawText
) {

  return {

    document_type:
      "unknown",

    nik:
      (
        String(rawText)
          .match(
            /\b\d{16}\b/
          ) ||
        []
      )[0] ||
      null

  };

}


// ============================================================
// VALIDATION
// ============================================================

function validate(
  type,
  data
) {

  const missing = [];

  const invalid = [];

  if (
    type === "ktp"
  ) {

    if (!data.nik)
      missing.push("NIK");

    if (!data.nama)
      missing.push("Nama");

    if (!data.tempat_lahir)
      missing.push(
        "Tempat Lahir"
      );

    if (!data.tanggal_lahir)
      missing.push(
        "Tanggal Lahir"
      );

    if (!data.jenis_kelamin)
      missing.push(
        "Jenis Kelamin"
      );

  }

  if (
    type === "passport"
  ) {

    if (!data.nomor_passport)
      missing.push(
        "Nomor Passport"
      );

    if (!data.nama)
      missing.push(
        "Nama"
      );

    if (!data.nationality)
      missing.push(
        "Nationality"
      );

    if (!data.tanggal_lahir)
      missing.push(
        "Tanggal Lahir"
      );

    if (!data.tempat_lahir)
      missing.push(
        "Tempat Lahir"
      );

    if (!data.jenis_kelamin)
      missing.push(
        "Jenis Kelamin"
      );

    if (!data.tanggal_terbit)
      missing.push(
        "Tanggal Terbit"
      );

    if (!data.expiry_date)
      missing.push(
        "Tanggal Expired"
      );

    if (!data.issuing_authority)
      missing.push(
        "Issuing Office"
      );

    if (
      data.tempat_lahir &&
      isDate(
        data.tempat_lahir
      )
    ) {
      invalid.push(
        "Tempat Lahir terbaca sebagai tanggal"
      );
    }

  }

  if (
    type === "kk"
  ) {

    if (!data.no_kk)
      missing.push(
        "No. KK"
      );

    if (
      !data.members ||
      !data.members.length
    ) {
      missing.push(
        "Data anggota KK"
      );
    }

  }

  return {

    valid:
      missing.length === 0 &&
      invalid.length === 0,

    missing,

    invalid

  };

}
