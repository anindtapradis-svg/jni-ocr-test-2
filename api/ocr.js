// ============================================================
// JNI TRAVEL OCR
// OCR.SPACE - ENGINE 2
// POSITION-AWARE PARSER
//
// Dokumen:
// 1. KTP
// 2. KK
// 3. Passport
//
// Prinsip:
// - KTP: value umumnya berada DI SEBELAH KANAN label
// - Passport: value umumnya berada DI BAWAH label
// - KK: data anggota dibaca sebagai tabel
// - Nama Ayah WAJIB dari kolom Nama Ayah
// ============================================================

module.exports = async function handler(req, res) {

  // ----------------------------------------------------------
  // METHOD
  // ----------------------------------------------------------

  if (req.method !== "POST") {
    return res.status(405).json({
      ok: false,
      error: "Method not allowed",
      method: req.method
    });
  }

  try {

    // --------------------------------------------------------
    // API KEY
    // --------------------------------------------------------

    const apiKey =
      process.env.OCR_SPACE_API_KEY;

    if (!apiKey) {
      return res.status(500).json({
        ok: false,
        error:
          "OCR_SPACE_API_KEY belum tersedia."
      });
    }

    // --------------------------------------------------------
    // REQUEST
    // --------------------------------------------------------

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

    // --------------------------------------------------------
    // FORMAT
    // --------------------------------------------------------

    const allowedTypes = [
      "image/jpeg",
      "image/png",
      "application/pdf"
    ];

    if (!allowedTypes.includes(mimeType)) {
      return res.status(400).json({
        ok: false,
        error:
          "Format tidak didukung. Gunakan JPG, PNG, atau PDF."
      });
    }

    // --------------------------------------------------------
    // DATA URL
    // --------------------------------------------------------

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

    // --------------------------------------------------------
    // MAX 1 MB
    // --------------------------------------------------------

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

    // --------------------------------------------------------
    // OCR.SPACE FORM
    // --------------------------------------------------------

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

    // English cukup untuk layout Indonesia.
    // Engine akan tetap membaca nama/alamat Indonesia.
    form.append(
      "language",
      "eng"
    );

    // PENTING:
    // kita membutuhkan koordinat.
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

    // --------------------------------------------------------
    // CALL OCR.SPACE
    // --------------------------------------------------------

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
          "OCR.space mengembalikan response yang tidak valid.",
        httpStatus:
          response.status
      });
    }

    // --------------------------------------------------------
    // OCR ERROR
    // --------------------------------------------------------

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

    // --------------------------------------------------------
    // RESULTS
    // --------------------------------------------------------

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

    // --------------------------------------------------------
    // RAW TEXT
    // --------------------------------------------------------

    const rawText =
      parsedResults
        .map(
          x =>
            x?.ParsedText ||
            ""
        )
        .filter(Boolean)
        .join("\n");

    // --------------------------------------------------------
    // OVERLAY
    // --------------------------------------------------------

    const overlay =
      parsedResults
        .map(
          x =>
            x?.TextOverlay ||
            null
        )
        .filter(Boolean);

    if (!rawText.trim()) {
      return res.status(422).json({
        ok: false,
        error:
          "OCR selesai tetapi teks tidak ditemukan."
      });
    }

    // --------------------------------------------------------
    // TYPE
    // --------------------------------------------------------

    const type =
      detectDocumentType(
        documentType,
        rawText
      );

    // --------------------------------------------------------
    // PARSE
    // --------------------------------------------------------

    let data;

    if (type === "ktp") {

      data =
        parseKTP(
          rawText,
          overlay
        );

    } else if (
      type === "passport"
    ) {

      data =
        parsePassport(
          rawText,
          overlay
        );

    } else if (
      type === "kk"
    ) {

      data =
        parseKK(
          rawText,
          overlay
        );

    } else {

      data =
        parseGeneric(
          rawText
        );

    }

    // --------------------------------------------------------
    // VALIDATION
    // --------------------------------------------------------

    const validation =
      validate(
        type,
        data
      );

    // --------------------------------------------------------
    // RESPONSE
    // --------------------------------------------------------

    return res.status(200).json({

      ok: true,

      fileName:
        fileName || null,

      documentType:
        type,

      data,

      validation,

      rawText,

      // koordinat disimpan agar kita
      // bisa debugging kalau ada dokumen aneh
      overlay,

      ocr: {

        engine: 2,

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

  } catch (error) {

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

  const v =
    String(input || "")
      .toLowerCase();

  if (
    v.includes("ktp")
  ) {
    return "ktp";
  }

  if (
    v === "kk" ||
    v.includes("kartu keluarga")
  ) {
    return "kk";
  }

  if (
    v.includes("passport") ||
    v.includes("paspor")
  ) {
    return "passport";
  }

  const t =
    String(text || "")
      .toUpperCase();

  if (
    t.includes("KARTU KELUARGA") ||
    t.includes("NAMA AYAH")
  ) {
    return "kk";
  }

  if (
    t.includes("PASPOR") ||
    t.includes("PASSPORT") ||
    t.includes("NO. PASPOR")
  ) {
    return "passport";
  }

  if (
    t.includes("NIK") &&
    (
      t.includes("TEMPAT/TGL") ||
      t.includes("TEMPAT / TGL")
    )
  ) {
    return "ktp";
  }

  return "unknown";
}


// ============================================================
// BASIC
// ============================================================

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


function normalizeUpper(
  value
) {

  return String(
    value || ""
  )
    .toUpperCase()
    .replace(
      /[^A-Z0-9]+/g,
      " "
    )
    .replace(
      /\s+/g,
      " "
    )
    .trim();

}


// ============================================================
// DATE
// ============================================================

function normalizeDate(
  value
) {

  if (!value) {
    return null;
  }

  const v =
    clean(value);

  if (!v) {
    return null;
  }

  const numeric =
    v.match(
      /\b(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{4})\b/
    );

  if (numeric) {

    return (
      numeric[1].padStart(2, "0") +
      "-" +
      numeric[2].padStart(2, "0") +
      "-" +
      numeric[3]
    );

  }

  return v;

}


// ============================================================
// OVERLAY -> LINES
// ============================================================

function getLines(
  overlay
) {

  const lines = [];

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
        Number(
          line.MinTop ??
          sorted[0]?.Top ??
          0
        );

      const bottom =
        Math.max(
          ...sorted.map(
            w =>
              Number(
                w.Top ?? top
              ) +
              Number(
                w.Height || 0
              )
          )
        );

      lines.push({

        text,

        words: sorted,

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

  return lines.sort(
    (a, b) =>
      a.top - b.top ||
      a.left - b.left
  );

}


// ============================================================
// LABEL MATCHING
// ============================================================

function lineContainsLabel(
  line,
  labels
) {

  const text =
    normalizeUpper(
      line.text
    );

  return labels.some(
    label =>
      text.includes(
        normalizeUpper(label)
      )
  );

}


// ============================================================
// FIND LABEL LINE
// ============================================================

function findLabelLine(
  lines,
  labels
) {

  return lines.find(
    line =>
      lineContainsLabel(
        line,
        labels
      )
  );

}


// ============================================================
// FIND ALL LABEL LINES
// ============================================================

function findLabelLines(
  lines,
  labels
) {

  return lines.filter(
    line =>
      lineContainsLabel(
        line,
        labels
      )
  );

}


// ============================================================
// WORD POSITION
// ============================================================

function labelGeometry(
  line,
  labels
) {

  const words =
    line.words || [];

  if (!words.length) {
    return null;
  }

  const normalizedWords =
    words.map(
      (w, index) => ({
        index,

        raw:
          String(
            w.WordText || ""
          ),

        norm:
          normalizeUpper(
            w.WordText || ""
          ),

        left:
          Number(
            w.Left || 0
          ),

        right:
          Number(
            w.Left || 0
          ) +
          Number(
            w.Width || 0
          ),

        top:
          Number(
            w.Top ??
            line.top
          ),

        bottom:
          Number(
            w.Top ??
            line.top
          ) +
          Number(
            w.Height || 0
          )
      })
    );

  // ----------------------------------------------------------
  // cari sequence kata label
  // ----------------------------------------------------------

  for (
    const label of labels
  ) {

    const target =
      normalizeUpper(
        label
      )
      .split(" ")
      .filter(Boolean);

    if (!target.length) {
      continue;
    }

    for (
      let i = 0;
      i <=
      normalizedWords.length -
        target.length;
      i++
    ) {

      let ok = true;

      for (
        let j = 0;
        j < target.length;
        j++
      ) {

        const actual =
          normalizedWords[
            i + j
          ].norm;

        const expected =
          target[j];

        if (
          !actual.includes(
            expected
          ) &&
          !expected.includes(
            actual
          )
        ) {
          ok = false;
          break;
        }

      }

      if (ok) {

        const group =
          normalizedWords.slice(
            i,
            i + target.length
          );

        return {

          startIndex: i,

          endIndex:
            i +
            target.length -
            1,

          left:
            group[0].left,

          right:
            group[group.length - 1]
              .right,

          top:
            Math.min(
              ...group.map(
                x => x.top
              )
            ),

          bottom:
            Math.max(
              ...group.map(
                x => x.bottom
              )
            ),

          centerX:
            (
              group[0].left +
              group[group.length - 1]
                .right
            ) / 2

        };

      }

    }

  }

  // fallback: gunakan seluruh line
  return {

    startIndex: 0,

    endIndex:
      words.length - 1,

    left:
      line.left,

    right:
      line.right,

    top:
      line.top,

    bottom:
      line.bottom,

    centerX:
      line.centerX

  };

}


// ============================================================
// KTP
//
// Layout KTP:
// LABEL : VALUE
//
// Kita mengambil VALUE dari kata-kata
// di sebelah kanan label.
// ============================================================

function extractKTPRightValue(
  lines,
  labels,
  options = {}
) {

  const line =
    findLabelLine(
      lines,
      labels
    );

  if (!line) {
    return null;
  }

  const geo =
    labelGeometry(
      line,
      labels
    );

  if (!geo) {
    return null;
  }

  const words =
    line.words || [];

  const valueWords = [];

  const minGap =
    options.minGap ?? 4;

  const maxDistance =
    options.maxDistance ?? 700;

  for (
    let i =
      geo.endIndex + 1;
    i < words.length;
    i++
  ) {

    const w =
      words[i];

    const left =
      Number(
        w.Left || 0
      );

    const right =
      left +
      Number(
        w.Width || 0
      );

    // harus berada di kanan label
    if (
      left <
      geo.right +
      minGap
    ) {
      continue;
    }

    // jangan terlalu jauh
    if (
      left -
      geo.right >
      maxDistance
    ) {
      break;
    }

    const word =
      String(
        w.WordText || ""
      );

    if (!word.trim()) {
      continue;
    }

    valueWords.push(word);

  }

  if (!valueWords.length) {
    return null;
  }

  let value =
    clean(
      valueWords.join(" ")
    );

  // ----------------------------------------------------------
  // bersihkan label berikutnya jika OCR menyatukan beberapa
  // field pada satu baris
  // ----------------------------------------------------------

  const stopPatterns = [
    "AGAMA",
    "STATUS PERKAWINAN",
    "PEKERJAAN",
    "KEWARGANEGARAAN",
    "BERLAKU HINGGA"
  ];

  for (
    const stop of stopPatterns
  ) {

    const index =
      normalizeUpper(
        value
      ).indexOf(
        normalizeUpper(stop)
      );

    if (index >= 0) {

      // gunakan versi raw dengan pendekatan regex
      const re =
        new RegExp(
          `\\b${stop
            .replace(
              /[.*+?^${}()|[\]\\]/g,
              "\\$&"
            )}\\b.*$`,
          "i"
        );

      value =
        clean(
          value.replace(
            re,
            ""
          )
        );

    }

  }

  return value;
}


// ============================================================
// KTP
// ============================================================

function parseKTP(
  rawText,
  overlay
) {

  const lines =
    getLines(
      overlay
    );

  // ----------------------------------------------------------
  // NIK
  // ----------------------------------------------------------

  const nik =
    extract16(
      rawText
    );

  // ----------------------------------------------------------
  // NAMA
  // ----------------------------------------------------------

  const nama =
    extractKTPRightValue(
      lines,
      ["NAMA"],
      {
        maxDistance: 700
      }
    );

  // ----------------------------------------------------------
  // TEMPAT / TGL LAHIR
  // ----------------------------------------------------------

  let tempatLahir = null;

  let tanggalLahir = null;

  const ttl =
    extractKTPRightValue(
      lines,
      [
        "TEMPAT/TGL LAHIR",
        "TEMPAT / TGL LAHIR",
        "TEMPAT/TGL. LAHIR",
        "TEMPAT / TGL. LAHIR",
        "TEMPAT TGL LAHIR"
      ],
      {
        maxDistance: 700
      }
    );

  if (ttl) {

    const date =
      ttl.match(
        /\b\d{1,2}[\/.\-]\d{1,2}[\/.\-]\d{4}\b/
      );

    if (date) {

      tanggalLahir =
        normalizeDate(
          date[0]
        );

      tempatLahir =
        clean(
          ttl.replace(
            date[0],
            ""
          )
        );

    } else {

      tempatLahir =
        ttl;

    }

  }

  // ----------------------------------------------------------
  // JENIS KELAMIN
  // ----------------------------------------------------------

  let jenisKelamin =
    extractKTPRightValue(
      lines,
      [
        "JENIS KELAMIN"
      ],
      {
        maxDistance: 500
      }
    );

  if (
    jenisKelamin
  ) {

    if (
      /LAKI/i.test(
        jenisKelamin
      )
    ) {
      jenisKelamin =
        "LAKI-LAKI";
    }

    else if (
      /PEREMPUAN/i.test(
        jenisKelamin
      )
    ) {
      jenisKelamin =
        "PEREMPUAN";
    }

  }

  // ----------------------------------------------------------
  // ALAMAT
  // ----------------------------------------------------------

  const alamat =
    extractKTPRightValue(
      lines,
      ["ALAMAT"],
      {
        maxDistance: 1000
      }
    );

  // ----------------------------------------------------------
  // RT/RW
  // ----------------------------------------------------------

  const rtRw =
    extractKTPRightValue(
      lines,
      ["RT/RW"],
      {
        maxDistance: 500
      }
    );

  // ----------------------------------------------------------
  // KELURAHAN
  // ----------------------------------------------------------

  const kelurahan =
    extractKTPRightValue(
      lines,
      [
        "KEL/DESA",
        "KELURAHAN/DESA",
        "KEL DESA"
      ],
      {
        maxDistance: 500
      }
    );

  // ----------------------------------------------------------
  // KECAMATAN
  // ----------------------------------------------------------

  const kecamatan =
    extractKTPRightValue(
      lines,
      ["KECAMATAN"],
      {
        maxDistance: 500
      }
    );

  // ----------------------------------------------------------
  // STATUS
  // ----------------------------------------------------------

  const statusPerkawinan =
    extractKTPRightValue(
      lines,
      ["STATUS PERKAWINAN"],
      {
        maxDistance: 500
      }
    );

  // ----------------------------------------------------------
  // PEKERJAAN
  // ----------------------------------------------------------

  const pekerjaan =
    extractKTPRightValue(
      lines,
      ["PEKERJAAN"],
      {
        maxDistance: 600
      }
    );

  // ----------------------------------------------------------
  // KEWARGANEGARAAN
  // ----------------------------------------------------------

  const kewarganegaraan =
    extractKTPRightValue(
      lines,
      ["KEWARGANEGARAAN"],
      {
        maxDistance: 500
      }
    );

  // ----------------------------------------------------------
  // FALLBACK
  // ----------------------------------------------------------

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
      statusPerkawinan,

    pekerjaan,

    kewarganegaraan

  };

}


// ============================================================
// PASSPORT
//
// Layout passport Indonesia pada contoh:
//
// LABEL
// VALUE
//
// Untuk field yang satu baris dengan field lain,
// kita cari VALUE tepat di bawah label berdasarkan
// overlap posisi X.
// ============================================================

function extractPassportBelowValue(
  lines,
  labels,
  options = {}
) {

  const labelLine =
    findLabelLine(
      lines,
      labels
    );

  if (!labelLine) {
    return null;
  }

  const geo =
    labelGeometry(
      labelLine,
      labels
    );

  if (!geo) {
    return null;
  }

  const labelLeft =
    geo.left;

  const labelRight =
    geo.right;

  const labelCenter =
    geo.centerX;

  const maxVertical =
    options.maxVertical ??
    90;

  const minVertical =
    options.minVertical ??
    3;

  const candidates = [];

  for (
    const line of lines
  ) {

    // harus di bawah
    if (
      line.top <=
      labelLine.bottom +
      minVertical
    ) {
      continue;
    }

    const dy =
      line.top -
      labelLine.bottom;

    if (
      dy >
      maxVertical
    ) {
      continue;
    }

    // --------------------------------------------------------
    // jangan mengambil baris label lain
    // --------------------------------------------------------

    if (
      lineContainsAnyLabel(
        line,
        PASSPORT_ALL_LABELS
      )
    ) {
      continue;
    }

    // --------------------------------------------------------
    // overlap X
    // --------------------------------------------------------

    const overlap =
      Math.max(
        0,
        Math.min(
          line.right,
          labelRight +
            (options.xTolerance ?? 80)
        ) -
        Math.max(
          line.left,
          labelLeft -
            (options.xTolerance ?? 80)
        )
      );

    const labelWidth =
      Math.max(
        1,
        labelRight -
          labelLeft
      );

    const overlapRatio =
      overlap /
      Math.min(
        labelWidth,
        Math.max(
          1,
          line.right -
            line.left
        )
      );

    const centerDistance =
      Math.abs(
        line.centerX -
        labelCenter
      );

    // --------------------------------------------------------
    // score
    // --------------------------------------------------------

    let score = 0;

    score +=
      Math.max(
        0,
        100 - dy
      );

    score +=
      overlapRatio *
      100;

    score +=
      Math.max(
        0,
        80 -
        centerDistance / 5
      );

    candidates.push({
      line,
      score,
      dy
    });

  }

  candidates.sort(
    (a, b) =>
      b.score -
      a.score
  );

  if (
    !candidates.length
  ) {
    return null;
  }

  let value =
    clean(
      candidates[0]
        .line
        .text
    );

  // ----------------------------------------------------------
  // Jangan pernah mengembalikan label template
  // ----------------------------------------------------------

  value =
    removePassportLabels(
      value
    );

  if (
    !value ||
    isPassportLabel(
      value
    )
  ) {
    return null;
  }

  return value;
}


// ============================================================
// PASSPORT LABELS
// ============================================================

const PASSPORT_ALL_LABELS = [

  "JENIS",
  "TYPE",

  "KODE NEGARA",
  "COUNTRY CODE",

  "NO. PASPOR",
  "PASSPORT NO",

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
// PASSPORT
// ============================================================

function parsePassport(
  rawText,
  overlay
) {

  const lines =
    getLines(
      overlay
    );

  // ----------------------------------------------------------
  // NOMOR PASSPORT
  // ----------------------------------------------------------

  let nomorPassport =
    extractPassportBelowValue(
      lines,
      [
        "NO. PASPOR",
        "NO PASPOR",
        "PASSPORT NO",
        "PASSPORT NUMBER"
      ],
      {
        maxVertical: 100,
        xTolerance: 100
      }
    );

  // fallback nomor passport
  if (
    !nomorPassport
  ) {

    const candidates =
      rawText.match(
        /\b[A-Z]\d{7}\b/gi
      ) || [];

    if (
      candidates.length
    ) {
      nomorPassport =
        candidates[0];
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

  // ----------------------------------------------------------
  // NAMA
  // ----------------------------------------------------------

  const nama =
    extractPassportBelowValue(
      lines,
      [
        "NAMA LENGKAP",
        "FULL NAME"
      ],
      {
        maxVertical: 100,
        xTolerance: 100
      }
    );

  // ----------------------------------------------------------
  // NATIONALITY
  // ----------------------------------------------------------

  const nationality =
    extractPassportBelowValue(
      lines,
      [
        "KEWARGANEGARAAN",
        "NATIONALITY"
      ],
      {
        maxVertical: 100,
        xTolerance: 100
      }
    );

  // ----------------------------------------------------------
  // DATE OF BIRTH
  // ----------------------------------------------------------

  let tanggalLahir =
    extractPassportBelowValue(
      lines,
      [
        "TGL. LAHIR",
        "TGL LAHIR",
        "DATE OF BIRTH"
      ],
      {
        maxVertical: 100,
        xTolerance: 90
      }
    );

  tanggalLahir =
    extractDateFromValue(
      tanggalLahir
    );

  // ----------------------------------------------------------
  // SEX
  // ----------------------------------------------------------

  let jenisKelamin =
    extractPassportBelowValue(
      lines,
      [
        "KELAMIN",
        "SEX"
      ],
      {
        maxVertical: 100,
        xTolerance: 90
      }
    );

  if (
    jenisKelamin
  ) {

    const sex =
      normalizeUpper(
        jenisKelamin
      );

    if (
      sex === "M" ||
      sex.includes("MALE")
    ) {
      jenisKelamin =
        "M";
    }

    else if (
      sex === "F" ||
      sex.includes("FEMALE")
    ) {
      jenisKelamin =
        "F";
    }

  }

  // ----------------------------------------------------------
  // TEMPAT LAHIR
  // ----------------------------------------------------------

  const tempatLahir =
    extractPassportBelowValue(
      lines,
      [
        "TEMPAT LAHIR",
        "PLACE OF BIRTH"
      ],
      {
        maxVertical: 100,
        xTolerance: 100
      }
    );

  // ----------------------------------------------------------
  // DATE OF ISSUE
  // ----------------------------------------------------------

  let tanggalTerbit =
    extractPassportBelowValue(
      lines,
      [
        "TGL. PENGELUARAN",
        "TGL PENGELUARAN",
        "DATE OF ISSUE"
      ],
      {
        maxVertical: 100,
        xTolerance: 100
      }
    );

  tanggalTerbit =
    extractDateFromValue(
      tanggalTerbit
    );

  // ----------------------------------------------------------
  // EXPIRY
  // ----------------------------------------------------------

  let expiryDate =
    extractPassportBelowValue(
      lines,
      [
        "TGL. HABIS BERLAKU",
        "TGL HABIS BERLAKU",
        "DATE OF EXPIRY"
      ],
      {
        maxVertical: 100,
        xTolerance: 100
      }
    );

  expiryDate =
    extractDateFromValue(
      expiryDate
    );

  // ----------------------------------------------------------
  // ISSUING OFFICE
  // ----------------------------------------------------------

  const issuingAuthority =
    extractPassportBelowValue(
      lines,
      [
        "KANTOR YANG MENGELUARKAN",
        "ISSUING OFFICE",
        "ISSUING AUTHORITY"
      ],
      {
        maxVertical: 120,
        xTolerance: 140
      }
    );

  // ----------------------------------------------------------
  // MRZ
  // ----------------------------------------------------------

  const mrz =
    extractMRZ(
      rawText
    );

  // ----------------------------------------------------------
  // MRZ QC
  // ----------------------------------------------------------

  const mrzParsed =
    parseMRZ(
      mrz
    );

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
      mrzParsed

  };

}


// ============================================================
// DATE FROM PASSPORT VALUE
// ============================================================

function extractDateFromValue(
  value
) {

  if (!value) {
    return null;
  }

  const numeric =
    value.match(
      /\b\d{1,2}[\/.\-]\d{1,2}[\/.\-]\d{4}\b/
    );

  if (numeric) {

    return normalizeDate(
      numeric[0]
    );

  }

  // contoh:
  // 12 MAY 2010

  const textual =
    value.match(
      /\b\d{1,2}\s+(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)[A-Z]*\s+\d{4}\b/i
    );

  if (textual) {

    return clean(
      textual[0]
    );

  }

  // kalau OCR langsung memberikan tanggal
  return clean(value);

}


// ============================================================
// PASSPORT LABEL TEST
// ============================================================

function isPassportLabel(
  value
) {

  const v =
    normalizeUpper(
      value
    );

  if (!v) {
    return true;
  }

  return PASSPORT_ALL_LABELS.some(
    label => {

      const l =
        normalizeUpper(
          label
        );

      return (
        v === l ||
        v.includes(l)
      );

    }
  );

}


// ============================================================
// REMOVE PASSPORT LABEL
// ============================================================

function removePassportLabels(
  value
) {

  let v =
    clean(value);

  if (!v) {
    return null;
  }

  // ----------------------------------------------------------
  // Contoh yang sebelumnya muncul:
  //
  // "/ FULL NAME"
  // "/ PLACE OF BIRTH"
  // "/ SEX"
  //
  // semuanya harus ditolak.
  // ----------------------------------------------------------

  v =
    v.replace(
      /^\/?\s*(FULL NAME|PLACE OF BIRTH|NATIONALITY|SEX|TYPE|COUNTRY CODE)\s*$/i,
      ""
    );

  return clean(v);

}


// ============================================================
// LABEL DETECTION
// ============================================================

function lineContainsAnyLabel(
  line,
  labels
) {

  return labels.some(
    label =>
      lineContainsLabel(
        line,
        [label]
      )
  );

}


// ============================================================
// PASSPORT MRZ
// ============================================================

function extractMRZ(
  text
) {

  const lines =
    String(text || "")
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

  // Passport MRZ biasanya 44 karakter
  const candidates =
    lines.filter(
      line => {

        const chevrons =
          (
            line.match(
              /</g
            ) || []
          ).length;

        return (
          line.length >= 30 &&
          chevrons >= 2
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
      );

  if (
    lines.length < 2
  ) {
    return null;
  }

  const line1 =
    lines[0];

  const line2 =
    lines[1];

  // ----------------------------------------------------------
  // TD3 passport:
  //
  // line 1:
  // P<IDO...
  //
  // line 2:
  // passport number
  // nationality
  // DOB
  // sex
  // expiry
  // ----------------------------------------------------------

  const result = {
    raw: mrz
  };

  if (
    line1.length >= 5
  ) {

    result.document_type =
      line1[0];

    result.country =
      line1.substring(
        2,
        5
      );

    const namePart =
      line1.substring(
        5
      );

    const nameSplit =
      namePart.split(
        "<<"
      );

    result.surname =
      clean(
        nameSplit[0]
          ?.replace(
            /</g,
            " "
          )
      );

    result.given_names =
      clean(
        (nameSplit[1] || "")
          .replace(
            /</g,
            " "
          )
      );

  }

  if (
    line2.length >= 20
  ) {

    result.passport_number =
      line2
        .substring(
          0,
          9
        )
        .replace(
          /</g,
          ""
        );

    result.nationality =
      line2.substring(
        10,
        13
      );

    result.birth_date =
      line2.substring(
        13,
        19
      );

    result.sex =
      line2.substring(
        20,
        21
      );

    result.expiry_date =
      line2.substring(
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
  overlay
) {

  const lines =
    getLines(
      overlay
    );

  // ----------------------------------------------------------
  // NO KK
  // ----------------------------------------------------------

  const all16 =
    rawText.match(
      /\b\d{16}\b/g
    ) || [];

  const noKK =
    all16[0] ||
    null;

  // ----------------------------------------------------------
  // Cari posisi header
  // ----------------------------------------------------------

  const nikHeader =
    findLabelLine(
      lines,
      ["NIK"]
    );

  const namaHeader =
    findLabelLine(
      lines,
      ["NAMA"]
    );

  const ayahHeader =
    findLabelLine(
      lines,
      [
        "NAMA AYAH"
      ]
    );

  const nikX =
    nikHeader?.centerX ??
    null;

  const namaX =
    namaHeader?.centerX ??
    null;

  const ayahX =
    ayahHeader?.centerX ??
    null;

  // ----------------------------------------------------------
  // Semua NIK
  // ----------------------------------------------------------

  const rows = [];

  for (
    let i = 0;
    i < lines.length;
    i++
  ) {

    const line =
      lines[i];

    const match =
      line.text.match(
        /\b\d{16}\b/
      );

    if (!match) {
      continue;
    }

    const nik =
      match[0];

    // --------------------------------------------------------
    // Cari line yang satu row
    // --------------------------------------------------------

    const rowCandidates =
      lines.filter(
        candidate => {

          if (
            candidate === line
          ) {
            return false;
          }

          const dy =
            Math.abs(
              candidate.centerY -
              line.centerY
            );

          return (
            dy <= 35
          );

        }
      );

    // --------------------------------------------------------
    // NAMA
    // --------------------------------------------------------

    let nama =
      findNearestColumnValue(
        rowCandidates,
        line,
        namaX
      );

    // fallback:
    // cari teks di kanan NIK
    if (!nama) {

      const right =
        rowCandidates
          .filter(
            x =>
              x.left >
              line.right
          )
          .sort(
            (a, b) =>
              a.left -
              b.left
          );

      if (
        right.length
      ) {

        nama =
          clean(
            right[0].text
          );

      }

    }

    // --------------------------------------------------------
    // NAMA AYAH
    //
    // SANGAT PENTING:
    //
    // Tidak pernah mengambil Kepala Keluarga.
    // Hanya dari kolom Nama Ayah.
    // --------------------------------------------------------

    let namaAyah =
      null;

    if (
      ayahX !== null
    ) {

      namaAyah =
        findNearestColumnValue(
          rowCandidates,
          line,
          ayahX
        );

    }

    rows.push({

      nik,

      nama:
        clean(nama),

      nama_ayah:
        clean(namaAyah)

    });

  }

  // ----------------------------------------------------------
  // DEDUPE
  // ----------------------------------------------------------

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
// KK COLUMN VALUE
// ============================================================

function findNearestColumnValue(
  candidates,
  sourceLine,
  columnX
) {

  if (
    columnX === null ||
    columnX === undefined
  ) {
    return null;
  }

  const valid =
    candidates
      .filter(
        candidate => {

          // Jangan ambil NIK lagi
          if (
            /\b\d{16}\b/.test(
              candidate.text
            )
          ) {
            return false;
          }

          const distance =
            Math.abs(
              candidate.centerX -
              columnX
            );

          return (
            distance <= 150
          );

        }
      )
      .sort(
        (a, b) => {

          const da =
            Math.abs(
              a.centerX -
              columnX
            );

          const db =
            Math.abs(
              b.centerX -
              columnX
            );

          return da - db;

        }
      );

  if (
    !valid.length
  ) {
    return null;
  }

  return clean(
    valid[0].text
  );

}


// ============================================================
// GENERIC
// ============================================================

function parseGeneric(
  text
) {

  return {

    document_type:
      "unknown",

    nik:
      extract16(text),

    raw_text_available:
      true

  };

}


// ============================================================
// EXTRACT 16 DIGIT
// ============================================================

function extract16(
  text
) {

  const values =
    String(text || "")
      .match(
        /\b\d{16}\b/g
      ) || [];

  return (
    values[0] ||
    null
  );

}


// ============================================================
// VALIDATION
// ============================================================

function validate(
  type,
  data
) {

  const missing = [];

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

    if (
      !data.nomor_passport
    ) {
      missing.push(
        "Nomor Passport"
      );
    }

    if (!data.nama) {
      missing.push(
        "Nama"
      );
    }

    if (
      !data.nationality
    ) {
      missing.push(
        "Nationality"
      );
    }

    if (
      !data.tanggal_lahir
    ) {
      missing.push(
        "Tanggal Lahir"
      );
    }

    if (
      !data.tempat_lahir
    ) {
      missing.push(
        "Tempat Lahir"
      );
    }

    if (
      !data.jenis_kelamin
    ) {
      missing.push(
        "Jenis Kelamin"
      );
    }

    if (
      !data.tanggal_terbit
    ) {
      missing.push(
        "Tanggal Terbit"
      );
    }

    if (
      !data.expiry_date
    ) {
      missing.push(
        "Tanggal Expired"
      );
    }

    if (
      !data.issuing_authority
    ) {
      missing.push(
        "Issuing Office"
      );
    }

  }

  if (
    type === "kk"
  ) {

    if (!data.no_kk) {
      missing.push(
        "No. KK"
      );
    }

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
      missing.length === 0,

    missing

  };

}
