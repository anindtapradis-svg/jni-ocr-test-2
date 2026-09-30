module.exports = async function handler(req, res) {
  // =========================================================
  // JNI TRAVEL - OCR API
  // OCR ENGINE: OCR.SPACE
  // =========================================================

  if (req.method !== "POST") {
    return res.status(405).json({
      ok: false,
      error: "Method not allowed",
      method: req.method
    });
  }

  try {
    // =======================================================
    // 1. API KEY
    // =======================================================

    const apiKey = process.env.OCR_SPACE_API_KEY;

    if (!apiKey) {
      return res.status(500).json({
        ok: false,
        error: "OCR_SPACE_API_KEY belum tersedia di Vercel."
      });
    }

    // =======================================================
    // 2. DATA DARI FRONTEND
    // =======================================================

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

    // =======================================================
    // 3. VALIDASI FORMAT
    // =======================================================

    const allowedTypes = [
      "image/jpeg",
      "image/png",
      "image/webp",
      "application/pdf"
    ];

    if (mimeType && !allowedTypes.includes(mimeType)) {
      return res.status(400).json({
        ok: false,
        error: `Format file tidak didukung: ${mimeType}`
      });
    }

    // =======================================================
    // 4. DATA URL
    // =======================================================

    const match = dataUrl.match(
      /^data:([^;]+);base64,(.+)$/
    );

    if (!match) {
      return res.status(400).json({
        ok: false,
        error: "Format data file tidak valid."
      });
    }

    const detectedMime = match[1];
    const base64Data = match[2];

    // =======================================================
    // 5. LIMIT FILE OCR.SPACE FREE
    // =======================================================

    const fileSizeBytes = Math.ceil(
      (base64Data.length * 3) / 4
    );

    const MAX_BYTES = 1 * 1024 * 1024;

    if (fileSizeBytes > MAX_BYTES) {
      return res.status(400).json({
        ok: false,
        error:
          "Ukuran file lebih dari 1 MB. Kompres file terlebih dahulu."
      });
    }

    // =======================================================
    // 6. WEBP
    // =======================================================

    if (detectedMime === "image/webp") {
      return res.status(400).json({
        ok: false,
        error:
          "WEBP belum didukung langsung oleh OCR.space. Gunakan JPG atau PNG."
      });
    }

    // =======================================================
    // 7. REQUEST OCR.SPACE
    // =======================================================

    const form = new FormData();

    form.append(
      "base64Image",
      `data:${detectedMime};base64,${base64Data}`
    );

    form.append("language", "eng");
    form.append("OCREngine", "2");
    form.append("isOverlayRequired", "false");
    form.append("detectOrientation", "true");
    form.append("scale", "true");

    const ocrResponse = await fetch(
      "https://api.ocr.space/parse/image",
      {
        method: "POST",
        headers: {
          apikey: apiKey
        },
        body: form
      }
    );

    const rawResponse = await ocrResponse.text();

    let ocrResult;

    try {
      ocrResult = JSON.parse(rawResponse);
    } catch {
      return res.status(502).json({
        ok: false,
        error: "OCR.space mengembalikan response bukan JSON.",
        httpStatus: ocrResponse.status,
        raw: rawResponse.substring(0, 2000)
      });
    }

    // =======================================================
    // 8. ERROR OCR.SPACE
    // =======================================================

    if (!ocrResponse.ok) {
      return res.status(502).json({
        ok: false,
        error: "OCR.space API error.",
        httpStatus: ocrResponse.status,
        details: ocrResult
      });
    }

    if (ocrResult.IsErroredOnProcessing) {
      return res.status(422).json({
        ok: false,
        error:
          ocrResult.ErrorMessage ||
          "OCR gagal memproses dokumen.",
        details: ocrResult.ErrorDetails || null
      });
    }

    // =======================================================
    // 9. AMBIL SEMUA HASIL OCR
    // =======================================================

    const parsedResults = Array.isArray(
      ocrResult.ParsedResults
    )
      ? ocrResult.ParsedResults
      : [];

    const rawText = parsedResults
      .map(item => item?.ParsedText || "")
      .filter(Boolean)
      .join("\n");

    if (!rawText.trim()) {
      return res.status(422).json({
        ok: false,
        error: "OCR selesai tetapi tidak menemukan teks."
      });
    }

    const text = normalizeText(rawText);

    // =======================================================
    // 10. TENTUKAN JENIS DOKUMEN
    // =======================================================

    const type = normalizeDocumentType(
      documentType,
      text
    );

    // =======================================================
    // 11. PARSER
    // =======================================================

    let data = {};

    if (type === "ktp") {
      data = parseKTP(text);
    } else if (type === "kk") {
      data = parseKK(text);
    } else if (type === "passport") {
      data = parsePassport(text);
    } else {
      data = parseGeneric(text);
    }

    // =======================================================
    // 12. VALIDATION
    // =======================================================

    const validation = validateData(type, data);

    // =======================================================
    // 13. RESPONSE
    // =======================================================

    return res.status(200).json({
      ok: true,

      fileName: fileName || null,

      documentType: type,

      data,

      validation,

      rawText,

      ocr: {
        engine: 2,
        exitCode: ocrResult.OCRExitCode || null,
        processingTimeMs:
          ocrResult.ProcessingTimeInMilliseconds || null,
        pages: parsedResults.length
      }
    });

  } catch (error) {
    console.error("JNI OCR ERROR:", error);

    return res.status(500).json({
      ok: false,
      error: "Terjadi error pada server OCR.",
      details: error?.message || String(error)
    });
  }
};


// =========================================================
// NORMALIZE TEXT
// =========================================================

function normalizeText(value) {
  return String(value || "")
    .replace(/\r/g, "")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}


// =========================================================
// NORMALIZE DOCUMENT TYPE
// =========================================================

function normalizeDocumentType(input, text) {
  const value = String(input || "")
    .toLowerCase()
    .trim();

  if (
    value.includes("ktp") ||
    value.includes("identity")
  ) {
    return "ktp";
  }

  if (
    value === "kk" ||
    value.includes("kartu keluarga") ||
    value.includes("family")
  ) {
    return "kk";
  }

  if (
    value.includes("passport") ||
    value.includes("paspor")
  ) {
    return "passport";
  }

  // fallback otomatis
  if (
    /\bNIK\b/i.test(text) &&
    /Nama/i.test(text)
  ) {
    return "ktp";
  }

  if (
    /KARTU KELUARGA/i.test(text) ||
    /Nama Ayah/i.test(text)
  ) {
    return "kk";
  }

  if (
    /PASSPORT/i.test(text) ||
    /P<O/i.test(text)
  ) {
    return "passport";
  }

  return "unknown";
}


// =========================================================
// CLEAN VALUE
// =========================================================

function cleanValue(value) {
  if (!value) return null;

  return String(value)
    .replace(/\s+/g, " ")
    .replace(/^[:\-–—\s]+/, "")
    .replace(/[:\-–—\s]+$/, "")
    .trim() || null;
}


// =========================================================
// DATE NORMALIZER
// =========================================================

function normalizeDate(value) {
  if (!value) return null;

  let v = value
    .replace(/\s+/g, " ")
    .trim();

  // DD-MM-YYYY
  let m = v.match(
    /\b(\d{1,2})[-\/.](\d{1,2})[-\/.](\d{4})\b/
  );

  if (m) {
    return `${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}-${m[3]}`;
  }

  // DD MONTH YYYY
  const months = {
    JANUARI: "01",
    FEBRUARI: "02",
    MARET: "03",
    APRIL: "04",
    MEI: "05",
    JUNI: "06",
    JULI: "07",
    AGUSTUS: "08",
    SEPTEMBER: "09",
    OKTOBER: "10",
    NOVEMBER: "11",
    DESEMBER: "12",

    JANUARY: "01",
    FEBRUARY: "02",
    MARCH: "03",
    MAY: "05",
    JUNE: "06",
    JULY: "07",
    AUGUST: "08",
    OCTOBER: "10",
    DECEMBER: "12"
  };

  const monthRegex = Object.keys(months).join("|");

  const monthMatch = v.match(
    new RegExp(
      `\\b(\\d{1,2})\\s+(${monthRegex})\\s+(\\d{4})\\b`,
      "i"
    )
  );

  if (monthMatch) {
    return `${monthMatch[1].padStart(2, "0")}-${months[monthMatch[2].toUpperCase()]}-${monthMatch[3]}`;
  }

  return cleanValue(v);
}


// =========================================================
// NIK
// =========================================================

function extractNIK(text) {
  const matches =
    text.match(/\b\d{16}\b/g) || [];

  if (matches.length === 0) {
    return null;
  }

  return matches[0];
}


// =========================================================
// KK NUMBER
// =========================================================

function extractKKNumber(text) {
  const lines = text.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (
      /NO\.?\s*KK/i.test(line) ||
      /NOMOR\s*KARTU\s*KELUARGA/i.test(line)
    ) {
      const sameLine =
        line.match(/\b\d{16}\b/);

      if (sameLine) {
        return sameLine[0];
      }

      const nextLine =
        lines[i + 1]?.match(/\b\d{16}\b/);

      if (nextLine) {
        return nextLine[0];
      }
    }
  }

  // fallback
  return extractNIK(text);
}


// =========================================================
// LABEL VALUE
// =========================================================

function extractAfterLabel(
  text,
  labels,
  stopLabels = []
) {
  const lines = text.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    for (const label of labels) {
      const regex = new RegExp(
        `^${label}\\s*[:.]?\\s*(.*)$`,
        "i"
      );

      const match = line.match(regex);

      if (!match) continue;

      let value = match[1]?.trim();

      if (value) {
        // Kalau ada label berikutnya di baris yang sama,
        // potong di sana.
        for (const stop of stopLabels) {
          const stopRegex = new RegExp(
            `\\s+${stop}\\s*[:.]?`,
            "i"
          );

          value = value.split(stopRegex)[0];
        }

        return cleanValue(value);
      }

      // value ada di baris berikutnya
      if (lines[i + 1]) {
        let next = lines[i + 1].trim();

        if (
          next &&
          !stopLabels.some(label2 =>
            new RegExp(
              `^${label2}\\s*[:.]?`,
              "i"
            ).test(next)
          )
        ) {
          return cleanValue(next);
        }
      }
    }
  }

  return null;
}


// =========================================================
// JENIS KELAMIN
// =========================================================

function extractGender(text) {
  const value = extractAfterLabel(
    text,
    [
      "Jenis Kelamin",
      "Jenis Kelamın"
    ],
    [
      "Gol\\. Darah",
      "Alamat",
      "RT/RW"
    ]
  );

  if (!value) return null;

  if (/LAKI/i.test(value)) {
    return "LAKI-LAKI";
  }

  if (/PEREMPUAN/i.test(value)) {
    return "PEREMPUAN";
  }

  return value;
}


// =========================================================
// KTP PARSER
// =========================================================

function parseKTP(text) {
  const nik = extractNIK(text);

  const nama = extractAfterLabel(
    text,
    ["Nama"],
    [
      "Tempat/Tgl Lahir",
      "Tempat / Tgl Lahir",
      "Jenis Kelamin",
      "Alamat"
    ]
  );

  let birthPlace = null;
  let birthDate = null;

  const ttlLabels = [
    "Tempat/Tgl Lahir",
    "Tempat / Tgl Lahir",
    "Tempat/Tgl. Lahir",
    "Tempat / Tgl. Lahir"
  ];

  const lines = text.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (
      ttlLabels.some(label =>
        line.toLowerCase().includes(label.toLowerCase())
      )
    ) {
      let value = line;

      for (const label of ttlLabels) {
        value = value.replace(
          new RegExp(label, "i"),
          ""
        );
      }

      value = value
        .replace(/^[:.\-\s]+/, "")
        .trim();

      // Contoh:
      // BEKASI, 14-10-1999
      const dateMatch = value.match(
        /(\d{1,2}[-\/.]\d{1,2}[-\/.]\d{4})/
      );

      if (dateMatch) {
        birthDate = normalizeDate(
          dateMatch[1]
        );

        birthPlace = cleanValue(
          value
            .replace(dateMatch[1], "")
            .replace(/[,|-]\s*$/, "")
        );
      } else if (lines[i + 1]) {
        const next = lines[i + 1];

        const nextDate = next.match(
          /(\d{1,2}[-\/.]\d{1,2}[-\/.]\d{4})/
        );

        if (nextDate) {
          birthDate = normalizeDate(
            nextDate[1]
          );

          birthPlace = cleanValue(
            next
              .replace(nextDate[1], "")
              .replace(/[,|-]\s*$/, "")
          );
        }
      }

      break;
    }
  }

  const gender = extractGender(text);

  const alamat = extractAfterLabel(
    text,
    ["Alamat"],
    [
      "RT/RW",
      "Kel/Desa",
      "Kelurahan/Desa",
      "Kecamatan",
      "Agama",
      "Status Perkawinan"
    ]
  );

  const rtRw = extractAfterLabel(
    text,
    ["RT/RW"],
    [
      "Kel/Desa",
      "Kelurahan/Desa",
      "Kecamatan"
    ]
  );

  const kelurahan = extractAfterLabel(
    text,
    [
      "Kel/Desa",
      "Kelurahan/Desa"
    ],
    [
      "Kecamatan",
      "Agama",
      "Status Perkawinan"
    ]
  );

  const kecamatan = extractAfterLabel(
    text,
    ["Kecamatan"],
    [
      "Agama",
      "Status Perkawinan",
      "Pekerjaan",
      "Kewarganegaraan"
    ]
  );

  const statusPerkawinan = extractAfterLabel(
    text,
    ["Status Perkawinan"],
    [
      "Pekerjaan",
      "Kewarganegaraan"
    ]
  );

  const pekerjaan = extractAfterLabel(
    text,
    ["Pekerjaan"],
    [
      "Kewarganegaraan",
      "Berlaku Hingga"
    ]
  );

  const kewarganegaraan = extractAfterLabel(
    text,
    [
      "Kewarganegaraan",
      "Kewarganegaraan"
    ],
    [
      "Berlaku Hingga"
    ]
  );

  // Kota/Kabupaten & Provinsi
  const wilayah = extractKTPWilayah(text);

  return {
    document_type: "ktp",

    nik,

    nama,

    tempat_lahir: birthPlace,

    tanggal_lahir: birthDate,

    jenis_kelamin: gender,

    alamat,

    rt_rw: rtRw,

    kelurahan_desa: kelurahan,

    kecamatan,

    kabupaten_kota: wilayah.kabupaten_kota,

    provinsi: wilayah.provinsi,

    status_perkawinan: statusPerkawinan,

    pekerjaan,

    kewarganegaraan
  };
}


// =========================================================
// WILAYAH KTP
// =========================================================

function extractKTPWilayah(text) {
  const lines = text.split("\n");

  let kabupaten = null;
  let provinsi = null;

  for (const line of lines) {
    const value = line.trim();

    if (/^PROVINSI\b/i.test(value)) {
      provinsi = cleanValue(
        value.replace(/^PROVINSI/i, "")
      );
    }

    if (
      /^KABUPATEN\b/i.test(value) ||
      /^KOTA\b/i.test(value)
    ) {
      kabupaten = cleanValue(value);
    }
  }

  return {
    kabupaten_kota: kabupaten,
    provinsi
  };
}


// =========================================================
// KK PARSER
// =========================================================

function parseKK(text) {
  const noKK = extractKKNumber(text);

  const rows = parseKKRows(text);

  return {
    document_type: "kk",

    no_kk: noKK,

    members: rows
  };
}


// =========================================================
// KK ROW PARSER
//
// Fokus:
// NO KK
// NIK
// NAMA
// NAMA AYAH
//
// Tidak mengambil:
// pekerjaan
// agama
// status perkawinan
// hubungan keluarga
// =========================================================

function parseKKRows(text) {
  const lines = text
    .split("\n")
    .map(x => x.trim())
    .filter(Boolean);

  const results = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const nikMatch =
      line.match(/\b\d{16}\b/);

    if (!nikMatch) continue;

    const nik = nikMatch[0];

    let nama = null;
    let namaAyah = null;

    // Cari nama di baris sekitar NIK.
    // OCR KK sering membuat kolom menjadi
    // baris-baris terpisah.
    const nearby = lines.slice(
      Math.max(0, i - 3),
      Math.min(lines.length, i + 5)
    );

    // Coba format eksplisit:
    // Nama : XXX
    for (const candidate of nearby) {
      const nameMatch = candidate.match(
        /^Nama\s*[:.]?\s*(.+)$/i
      );

      if (nameMatch) {
        nama = cleanValue(
          nameMatch[1]
        );
      }

      const fatherMatch = candidate.match(
        /^Nama Ayah\s*[:.]?\s*(.+)$/i
      );

      if (fatherMatch) {
        namaAyah = cleanValue(
          fatherMatch[1]
        );
      }
    }

    results.push({
      nik,
      nama,
      nama_ayah: namaAyah
    });
  }

  return dedupeKKMembers(results);
}


// =========================================================
// DEDUPE KK
// =========================================================

function dedupeKKMembers(rows) {
  const map = new Map();

  for (const row of rows) {
    if (!row.nik) continue;

    if (!map.has(row.nik)) {
      map.set(row.nik, row);
    } else {
      const old = map.get(row.nik);

      map.set(row.nik, {
        nik: row.nik,
        nama: old.nama || row.nama,
        nama_ayah:
          old.nama_ayah ||
          row.nama_ayah ||
          null
      });
    }
  }

  return Array.from(map.values());
}


// =========================================================
// PASSPORT PARSER
// =========================================================

function parsePassport(text) {
  const passportNumber =
    extractPassportNumber(text);

  const nationality =
    extractAfterLabel(
      text,
      [
        "Nationality",
        "Kewarganegaraan"
      ],
      [
        "Date of Birth",
        "Date Of Birth",
        "Tanggal Lahir",
        "Sex"
      ]
    );

  const dateOfBirth =
    extractAfterLabel(
      text,
      [
        "Date of Birth",
        "Date Of Birth",
        "DOB",
        "Tanggal Lahir"
      ],
      [
        "Sex",
        "Place of Birth",
        "Place Of Birth"
      ]
    );

  const placeOfBirth =
    extractAfterLabel(
      text,
      [
        "Place of Birth",
        "Place Of Birth",
        "Tempat Lahir"
      ],
      [
        "Date of Birth",
        "Date Of Birth",
        "Sex"
      ]
    );

  const gender =
    extractAfterLabel(
      text,
      ["Sex"],
      [
        "Date of Birth",
        "Place of Birth",
        "Nationality"
      ]
    );

  const issued =
    extractAfterLabel(
      text,
      [
        "Authority",
        "Issuing Authority",
        "Place of Issue",
        "Place Of Issue",
        "Issued By",
        "Kantor",
        "Authority"
      ],
      [
        "Date of Issue",
        "Date Of Issue",
        "Date of Expiry",
        "Date Of Expiry"
      ]
    );

  const dateIssued =
    extractAfterLabel(
      text,
      [
        "Date of Issue",
        "Date Of Issue",
        "Issued"
      ],
      [
        "Date of Expiry",
        "Date Of Expiry"
      ]
    );

  const expiry =
    extractAfterLabel(
      text,
      [
        "Date of Expiry",
        "Date Of Expiry",
        "Expiry Date",
        "Date of Expiration"
      ],
      [
        "Authority",
        "Issuing Authority"
      ]
    );

  const name =
    extractPassportName(text);

  const mrz =
    extractMRZ(text);

  return {
    document_type: "passport",

    nomor_passport: passportNumber,

    nama: name,

    nationality,

    tanggal_lahir: normalizeDate(dateOfBirth),

    tempat_lahir: placeOfBirth,

    jenis_kelamin: gender,

    tanggal_terbit: normalizeDate(dateIssued),

    expiry_date: normalizeDate(expiry),

    issuing_authority: issued,

    mrz
  };
}


// =========================================================
// PASSPORT NUMBER
// =========================================================

function extractPassportNumber(text) {
  const matches =
    text.match(
      /\b[A-Z][A-Z0-9]{6,8}\b/gi
    ) || [];

  for (const value of matches) {
    const upper = value.toUpperCase();

    // Hindari kata-kata umum
    if (
      [
        "PASSPORT",
        "NATIONAL",
        "AUTHORITY",
        "REPUBLIC",
        "INDONESIA"
      ].includes(upper)
    ) {
      continue;
    }

    if (/^[A-Z]\d{7}$/.test(upper)) {
      return upper;
    }
  }

  return null;
}


// =========================================================
// PASSPORT NAME
// =========================================================

function extractPassportName(text) {
  const value = extractAfterLabel(
    text,
    [
      "Surname",
      "Given Names",
      "Full Name",
      "Name"
    ],
    [
      "Nationality",
      "Date of Birth",
      "Date Of Birth",
      "Sex",
      "Place of Birth"
    ]
  );

  return value;
}


// =========================================================
// MRZ
// =========================================================

function extractMRZ(text) {
  const lines = text
    .split("\n")
    .map(line =>
      line
        .replace(/\s/g, "")
        .toUpperCase()
    )
    .filter(Boolean);

  const candidates = lines.filter(line => {
    if (line.length < 30) return false;

    const count =
      (line.match(/</g) || []).length;

    return count >= 3;
  });

  if (candidates.length >= 2) {
    return candidates
      .slice(-2)
      .join("\n");
  }

  return null;
}


// =========================================================
// GENERIC
// =========================================================

function parseGeneric(text) {
  return {
    document_type: "unknown",
    nik: extractNIK(text),
    nama: extractAfterLabel(
      text,
      ["Nama", "Name"]
    ),
    raw_text_available: true
  };
}


// =========================================================
// VALIDATION
// =========================================================

function validateData(type, data) {
  const result = {
    valid: true,
    missing: [],
    warnings: []
  };

  if (type === "ktp") {
    const required = [
      ["nik", "NIK"],
      ["nama", "Nama"],
      ["tempat_lahir", "Tempat Lahir"],
      ["tanggal_lahir", "Tanggal Lahir"],
      ["jenis_kelamin", "Jenis Kelamin"]
    ];

    for (const [key, label] of required) {
      if (!data[key]) {
        result.missing.push(label);
      }
    }
  }

  if (type === "kk") {
    if (!data.no_kk) {
      result.missing.push("No. KK");
    }

    if (!data.members?.length) {
      result.missing.push(
        "Data anggota KK"
      );
    }
  }

  if (type === "passport") {
    const required = [
      ["nomor_passport", "Nomor Passport"],
      ["nama", "Nama"],
      ["tanggal_lahir", "Tanggal Lahir"],
      ["jenis_kelamin", "Jenis Kelamin"]
    ];

    for (const [key, label] of required) {
      if (!data[key]) {
        result.missing.push(label);
      }
    }
  }

  result.valid =
    result.missing.length === 0;

  return result;
}
