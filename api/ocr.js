module.exports = async function handler(req, res) {
  // =========================================================
  // JNI TRAVEL OCR
  // OCR.SPACE - FREE
  // =========================================================

  if (req.method !== "POST") {
    return res.status(405).json({
      ok: false,
      error: "Method not allowed",
      method: req.method
    });
  }

  try {
    const apiKey = process.env.OCR_SPACE_API_KEY;

    if (!apiKey) {
      return res.status(500).json({
        ok: false,
        error: "OCR_SPACE_API_KEY belum tersedia di Vercel."
      });
    }

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
      "application/pdf"
    ];

    if (!allowedTypes.includes(mimeType)) {
      return res.status(400).json({
        ok: false,
        error:
          "Format tidak didukung. Gunakan JPG, PNG, atau PDF."
      });
    }

    // =======================================================
    // DATA URL
    // =======================================================

    const match = dataUrl.match(
      /^data:([^;]+);base64,(.+)$/
    );

    if (!match) {
      return res.status(400).json({
        ok: false,
        error: "Format file tidak valid."
      });
    }

    const detectedMime = match[1];
    const base64Data = match[2];

    // =======================================================
    // LIMIT FREE OCR.SPACE = 1 MB
    // =======================================================

    const fileSizeBytes = Math.ceil(
      (base64Data.length * 3) / 4
    );

    if (fileSizeBytes > 1024 * 1024) {
      return res.status(400).json({
        ok: false,
        error:
          "File lebih dari 1 MB. Kompres gambar terlebih dahulu."
      });
    }

    // =======================================================
    // FORM OCR.SPACE
    // =======================================================

    const form = new FormData();

    form.append(
      "base64Image",
      `data:${detectedMime};base64,${base64Data}`
    );

    // Engine 2
    form.append("OCREngine", "2");

    // Auto detect language
    form.append("language", "auto");

    // WAJIB untuk parser posisi
    form.append("isOverlayRequired", "true");

    // Auto rotate
    form.append("detectOrientation", "true");

    // Upscaling
    form.append("scale", "true");

    // KK adalah tabel
    if (
      String(documentType || "")
        .toLowerCase()
        .includes("kk")
    ) {
      form.append("isTable", "true");
    } else {
      form.append("isTable", "false");
    }

    // =======================================================
    // CALL OCR.SPACE
    // =======================================================

    const response = await fetch(
      "https://api.ocr.space/parse/image",
      {
        method: "POST",
        headers: {
          apikey: apiKey
        },
        body: form
      }
    );

    const raw = await response.text();

    let result;

    try {
      result = JSON.parse(raw);
    } catch {
      return res.status(502).json({
        ok: false,
        error:
          "OCR.space mengembalikan response bukan JSON.",
        httpStatus: response.status,
        raw: raw.substring(0, 2000)
      });
    }

    if (!response.ok) {
      return res.status(502).json({
        ok: false,
        error: "OCR.space API error.",
        httpStatus: response.status,
        details: result
      });
    }

    if (result.IsErroredOnProcessing) {
      return res.status(422).json({
        ok: false,
        error:
          result.ErrorMessage ||
          "OCR gagal memproses dokumen.",
        details:
          result.ErrorDetails || null
      });
    }

    // =======================================================
    // PARSED RESULTS
    // =======================================================

    const parsedResults =
      Array.isArray(result.ParsedResults)
        ? result.ParsedResults
        : [];

    if (!parsedResults.length) {
      return res.status(422).json({
        ok: false,
        error: "OCR tidak menghasilkan halaman."
      });
    }

    const rawText = parsedResults
      .map(x => x?.ParsedText || "")
      .filter(Boolean)
      .join("\n");

    const overlay = parsedResults
      .map(x => x?.TextOverlay || null)
      .filter(Boolean);

    if (!rawText.trim()) {
      return res.status(422).json({
        ok: false,
        error:
          "OCR selesai tetapi teks tidak ditemukan."
      });
    }

    // =======================================================
    // DETEKSI JENIS DOKUMEN
    // =======================================================

    const type = detectDocumentType(
      documentType,
      rawText
    );

    // =======================================================
    // PARSER
    // =======================================================

    let data;

    if (type === "ktp") {
      data = parseKTP(rawText, overlay);
    } else if (type === "passport") {
      data = parsePassport(rawText, overlay);
    } else if (type === "kk") {
      data = parseKK(rawText, overlay);
    } else {
      data = parseGeneric(rawText);
    }

    // =======================================================
    // VALIDATION
    // =======================================================

    const validation =
      validate(type, data);

    // =======================================================
    // RESPONSE
    // =======================================================

    return res.status(200).json({
      ok: true,

      fileName: fileName || null,

      documentType: type,

      data,

      validation,

      rawText,

      overlay,

      ocr: {
        engine: 2,
        exitCode:
          result.OCRExitCode || null,

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


// =========================================================
// DOCUMENT TYPE
// =========================================================

function detectDocumentType(input, text) {
  const v = String(input || "")
    .toLowerCase();

  if (v.includes("ktp")) {
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

  const t = text.toUpperCase();

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
    t.includes("TEMPAT/TGL LAHIR")
  ) {
    return "ktp";
  }

  return "unknown";
}


// =========================================================
// NORMALIZE
// =========================================================

function clean(value) {
  if (!value) return null;

  return String(value)
    .replace(/\s+/g, " ")
    .replace(/^[\s:;,\-–—]+/, "")
    .replace(/[\s:;,\-–—]+$/, "")
    .trim() || null;
}


// =========================================================
// DATE
// =========================================================

function normalizeDate(value) {
  if (!value) return null;

  const v = clean(value);

  if (!v) return null;

  const m = v.match(
    /\b(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{4})\b/
  );

  if (m) {
    return (
      m[1].padStart(2, "0") +
      "-" +
      m[2].padStart(2, "0") +
      "-" +
      m[3]
    );
  }

  return v;
}


// =========================================================
// OCR LINES
// =========================================================

function getLines(overlay) {
  const all = [];

  for (const page of overlay || []) {
    for (
      const line of page?.Lines || []
    ) {
      const words =
        line?.Words || [];

      if (!words.length) continue;

      const sorted =
        [...words].sort(
          (a, b) =>
            Number(a.Left || 0) -
            Number(b.Left || 0)
        );

      const text = sorted
        .map(x =>
          String(
            x.WordText || ""
          )
        )
        .join(" ")
        .trim();

      all.push({
        text,
        words: sorted,
        top: Number(
          line.MinTop || 0
        ),
        height: Number(
          line.MaxHeight || 0
        ),
        left: Number(
          sorted[0]?.Left || 0
        ),
        right:
          Math.max(
            ...sorted.map(
              x =>
                Number(x.Left || 0) +
                Number(x.Width || 0)
            )
          )
      });
    }
  }

  return all;
}


// =========================================================
// FIND VALUE ON SAME LINE
// =========================================================

function valueAfterLabel(
  lineText,
  labels
) {
  const upper =
    lineText.toUpperCase();

  for (const label of labels) {
    const idx =
      upper.indexOf(
        label.toUpperCase()
      );

    if (idx < 0) continue;

    let value =
      lineText.substring(
        idx + label.length
      );

    value = value
      .replace(/^[\s:.\-–—]+/, "")
      .trim();

    if (value) {
      return clean(value);
    }
  }

  return null;
}


// =========================================================
// FIND LINE BY LABEL
// =========================================================

function findLine(
  lines,
  labels
) {
  return lines.find(line =>
    labels.some(label =>
      line.text
        .toUpperCase()
        .includes(
          label.toUpperCase()
        )
    )
  );
}


// =========================================================
// FIND NEXT VALUE LINE
// =========================================================

function nextMeaningfulLine(
  lines,
  index,
  labels
) {
  for (
    let i = index + 1;
    i < Math.min(
      lines.length,
      index + 4
    );
    i++
  ) {
    const text =
      lines[i].text.trim();

    if (!text) continue;

    const isLabel =
      labels.some(label =>
        text
          .toUpperCase()
          .includes(
            label.toUpperCase()
          )
      );

    if (!isLabel) {
      return text;
    }
  }

  return null;
}


// =========================================================
// EXTRACT 16 DIGIT
// =========================================================

function extract16(text) {
  const found =
    text.match(
      /\b\d{16}\b/g
    ) || [];

  return found[0] || null;
}


// =========================================================
// KTP
// =========================================================

function parseKTP(
  text,
  overlay
) {
  const lines =
    getLines(overlay);

  // -------------------------
  // NIK
  // -------------------------

  const nik =
    extract16(text);

  // -------------------------
  // NAMA
  // -------------------------

  let nama = null;

  const namaLine =
    findLine(lines, ["NAMA"]);

  if (namaLine) {
    nama =
      valueAfterLabel(
        namaLine.text,
        ["NAMA"]
      );
  }

  // -------------------------
  // TEMPAT / TGL LAHIR
  // -------------------------

  let tempatLahir = null;
  let tanggalLahir = null;

  const ttlIndex =
    lines.findIndex(line =>
      /TEMPAT\s*\/?\s*TGL|TEMPAT\/TGL|TEMPAT\/TGL\.|TEMPAT.*LAHIR/i
        .test(line.text)
    );

  if (ttlIndex >= 0) {
    const current =
      lines[ttlIndex].text;

    let value =
      valueAfterLabel(
        current,
        [
          "TEMPAT/TGL LAHIR",
          "TEMPAT / TGL LAHIR",
          "TEMPAT/TGL. LAHIR",
          "TEMPAT / TGL. LAHIR"
        ]
      );

    if (!value) {
      value =
        nextMeaningfulLine(
          lines,
          ttlIndex,
          [
            "JENIS KELAMIN",
            "ALAMAT",
            "RT/RW"
          ]
        );
    }

    if (value) {
      const date =
        value.match(
          /\d{1,2}[\/.\-]\d{1,2}[\/.\-]\d{4}/
        );

      if (date) {
        tanggalLahir =
          normalizeDate(
            date[0]
          );

        tempatLahir =
          clean(
            value
              .replace(
                date[0],
                ""
              )
              .replace(
                /[,|]+$/,
                ""
              )
          );
      } else {
        // Cari tanggal pada baris berikut
        for (
          let i = ttlIndex;
          i <
          Math.min(
            lines.length,
            ttlIndex + 3
          );
          i++
        ) {
          const d =
            lines[i].text.match(
              /\d{1,2}[\/.\-]\d{1,2}[\/.\-]\d{4}/
            );

          if (d) {
            tanggalLahir =
              normalizeDate(
                d[0]
              );

            break;
          }
        }

        tempatLahir =
          clean(value);
      }
    }
  }

  // -------------------------
  // JENIS KELAMIN
  // -------------------------

  let jenisKelamin = null;

  const genderLine =
    findLine(lines, [
      "JENIS KELAMIN"
    ]);

  if (genderLine) {
    jenisKelamin =
      valueAfterLabel(
        genderLine.text,
        ["JENIS KELAMIN"]
      );

    if (
      jenisKelamin &&
      /LAKI/i.test(
        jenisKelamin
      )
    ) {
      jenisKelamin =
        "LAKI-LAKI";
    }

    if (
      jenisKelamin &&
      /PEREMPUAN/i.test(
        jenisKelamin
      )
    ) {
      jenisKelamin =
        "PEREMPUAN";
    }
  }

  // -------------------------
  // ALAMAT
  // -------------------------

  const alamat =
    getField(
      lines,
      [
        "ALAMAT"
      ],
      [
        "RT/RW",
        "KEL/DESA",
        "KELURAHAN/DESA",
        "KECAMATAN"
      ]
    );

  // -------------------------
  // RT/RW
  // -------------------------

  const rtRw =
    getField(
      lines,
      ["RT/RW"],
      [
        "KEL/DESA",
        "KELURAHAN/DESA",
        "KECAMATAN"
      ]
    );

  // -------------------------
  // KELURAHAN
  // -------------------------

  const kelurahan =
    getField(
      lines,
      [
        "KEL/DESA",
        "KELURAHAN/DESA"
      ],
      [
        "KECAMATAN"
      ]
    );

  // -------------------------
  // KECAMATAN
  // -------------------------

  const kecamatan =
    getField(
      lines,
      ["KECAMATAN"],
      [
        "AGAMA",
        "STATUS PERKAWINAN",
        "PEKERJAAN"
      ]
    );

  // -------------------------
  // STATUS PERKAWINAN
  // -------------------------

  const statusPerkawinan =
    getField(
      lines,
      ["STATUS PERKAWINAN"],
      [
        "PEKERJAAN",
        "KEWARGANEGARAAN"
      ]
    );

  // -------------------------
  // PEKERJAAN
  // -------------------------

  const pekerjaan =
    getField(
      lines,
      ["PEKERJAAN"],
      [
        "KEWARGANEGARAAN",
        "BERLAKU HINGGA"
      ]
    );

  // -------------------------
  // KEWARGANEGARAAN
  // -------------------------

  const kewarganegaraan =
    getField(
      lines,
      ["KEWARGANEGARAAN"],
      [
        "BERLAKU HINGGA"
      ]
    );

  return {
    document_type: "ktp",

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


// =========================================================
// GENERIC FIELD
// =========================================================

function getField(
  lines,
  labels,
  stopLabels
) {
  const index =
    lines.findIndex(line =>
      labels.some(label =>
        line.text
          .toUpperCase()
          .includes(
            label.toUpperCase()
          )
      )
    );

  if (index < 0) {
    return null;
  }

  const line =
    lines[index];

  let value =
    valueAfterLabel(
      line.text,
      labels
    );

  if (value) {
    // Potong kalau ada label berikutnya
    for (
      const stop of stopLabels
    ) {
      const pos =
        value
          .toUpperCase()
          .indexOf(
            stop.toUpperCase()
          );

      if (pos >= 0) {
        value =
          value.substring(
            0,
            pos
          ).trim();
      }
    }

    if (value) {
      return clean(value);
    }
  }

  return clean(
    nextMeaningfulLine(
      lines,
      index,
      stopLabels
    )
  );
}


// =========================================================
// PASSPORT
// =========================================================

function parsePassport(
  text,
  overlay
) {
  const lines =
    getLines(overlay);

  // -------------------------
  // PASSPORT NUMBER
  // -------------------------

  let nomorPassport = null;

  const passLine =
    findLine(lines, [
      "NO. PASPOR",
      "NO PASPOR",
      "PASSPORT NO",
      "PASSPORT NUMBER"
    ]);

  if (passLine) {
    nomorPassport =
      valueAfterLabel(
        passLine.text,
        [
          "NO. PASPOR",
          "NO PASPOR",
          "PASSPORT NO",
          "PASSPORT NUMBER"
        ]
      );
  }

  if (
    !nomorPassport ||
    !/^[A-Z0-9]{7,10}$/i.test(
      nomorPassport
    )
  ) {
    const matches =
      text.match(
        /\b[A-Z]\d{7}\b/gi
      ) || [];

    nomorPassport =
      matches[0] ||
      nomorPassport;
  }

  if (nomorPassport) {
    nomorPassport =
      nomorPassport
        .replace(
          /[^A-Z0-9]/gi,
          ""
        )
        .toUpperCase();
  }

  // -------------------------
  // NAMA
  // -------------------------

  const nama =
    getPassportField(
      lines,
      [
        "NAMA LENGKAP",
        "FULL NAME"
      ],
      [
        "KEWARGANEGARAAN",
        "NATIONALITY"
      ]
    );

  // -------------------------
  // NATIONALITY
  // -------------------------

  const nationality =
    getPassportField(
      lines,
      [
        "KEWARGANEGARAAN",
        "NATIONALITY"
      ],
      [
        "TGL. LAHIR",
        "TGL LAHIR",
        "DATE OF BIRTH"
      ]
    );

  // -------------------------
  // DATE OF BIRTH
  // -------------------------

  const tanggalLahir =
    getPassportDate(
      lines,
      [
        "TGL. LAHIR",
        "TGL LAHIR",
        "DATE OF BIRTH"
      ]
    );

  // -------------------------
  // SEX
  // -------------------------

  const jenisKelamin =
    getPassportField(
      lines,
      [
        "KELAMIN",
        "SEX"
      ],
      [
        "TEMPAT LAHIR",
        "PLACE OF BIRTH"
      ]
    );

  // -------------------------
  // PLACE OF BIRTH
  // -------------------------

  const tempatLahir =
    getPassportField(
      lines,
      [
        "TEMPAT LAHIR",
        "PLACE OF BIRTH"
      ],
      [
        "TGL. PENGELUARAN",
        "DATE OF ISSUE"
      ]
    );

  // -------------------------
  // DATE ISSUE
  // -------------------------

  const tanggalTerbit =
    getPassportDate(
      lines,
      [
        "TGL. PENGELUARAN",
        "TGL PENGELUARAN",
        "DATE OF ISSUE"
      ]
    );

  // -------------------------
  // EXPIRY
  // -------------------------

  const expiry =
    getPassportDate(
      lines,
      [
        "TGL. HABIS BERLAKU",
        "TGL HABIS BERLAKU",
        "DATE OF EXPIRY"
      ]
    );

  // -------------------------
  // ISSUING OFFICE
  // -------------------------

  const issuingAuthority =
    getPassportField(
      lines,
      [
        "KANTOR YANG MENGELUARKAN",
        "ISSUING OFFICE",
        "ISSUING AUTHORITY"
      ],
      [
        "MRZ",
        "NO. REG"
      ]
    );

  // -------------------------
  // MRZ
  // -------------------------

  const mrz =
    extractMRZ(text);

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
      expiry,

    issuing_authority:
      issuingAuthority,

    mrz
  };
}


// =========================================================
// PASSPORT FIELD
// =========================================================

function getPassportField(
  lines,
  labels,
  stopLabels
) {
  const index =
    lines.findIndex(line =>
      labels.some(label =>
        line.text
          .toUpperCase()
          .includes(
            label.toUpperCase()
          )
      )
    );

  if (index < 0) {
    return null;
  }

  const line =
    lines[index];

  // Jangan mengambil label itu sendiri
  let same =
    valueAfterLabel(
      line.text,
      labels
    );

  if (same) {
    const upper =
      same.toUpperCase();

    // Hindari hasil seperti:
    // / PLACE OF
    // PLACE OF
    if (
      /^\/?\s*PLACE OF/i.test(
        same
      )
    ) {
      same = null;
    }

    if (
      stopLabels.some(stop =>
        upper.includes(
          stop.toUpperCase()
        )
      )
    ) {
      same = null;
    }
  }

  if (same) {
    return clean(same);
  }

  // Cari baris setelah label
  for (
    let i = index + 1;
    i <
    Math.min(
      lines.length,
      index + 5
    );
    i++
  ) {
    const candidate =
      lines[i].text.trim();

    if (!candidate) continue;

    const isStop =
      stopLabels.some(stop =>
        candidate
          .toUpperCase()
          .includes(
            stop.toUpperCase()
          )
      );

    if (isStop) {
      continue;
    }

    // Jangan ambil label bilingual
    if (
      /^(PLACE OF|DATE OF|NO\.?|NATIONALITY|SEX|KELAMIN|TGL\.?)/i
        .test(candidate)
    ) {
      continue;
    }

    return clean(candidate);
  }

  return null;
}


// =========================================================
// PASSPORT DATE
// =========================================================

function getPassportDate(
  lines,
  labels
) {
  const index =
    lines.findIndex(line =>
      labels.some(label =>
        line.text
          .toUpperCase()
          .includes(
            label.toUpperCase()
          )
      )
    );

  if (index < 0) {
    return null;
  }

  const current =
    lines[index].text;

  let value =
    valueAfterLabel(
      current,
      labels
    );

  let date =
    value?.match(
      /\d{1,2}[\/.\-]\d{1,2}[\/.\-]\d{4}/
    );

  if (date) {
    return normalizeDate(
      date[0]
    );
  }

  // OCR passport sering memakai:
  // 01 JAN 1990
  const monthDate =
    value?.match(
      /\d{1,2}\s+[A-Z]{3,9}\s+\d{4}/i
    );

  if (monthDate) {
    return clean(
      monthDate[0]
    );
  }

  for (
    let i = index + 1;
    i <
    Math.min(
      lines.length,
      index + 4
    );
    i++
  ) {
    const t =
      lines[i].text;

    date =
      t.match(
        /\d{1,2}[\/.\-]\d{1,2}[\/.\-]\d{4}/
      );

    if (date) {
      return normalizeDate(
        date[0]
      );
    }

    const md =
      t.match(
        /\d{1,2}\s+[A-Z]{3,9}\s+\d{4}/i
      );

    if (md) {
      return clean(
        md[0]
      );
    }
  }

  return null;
}


// =========================================================
// MRZ
// =========================================================

function extractMRZ(text) {
  const lines =
    text
      .split("\n")
      .map(x =>
        x
          .replace(/\s/g, "")
          .toUpperCase()
      )
      .filter(Boolean);

  const candidates =
    lines.filter(line => {
      if (line.length < 25) {
        return false;
      }

      const chevrons =
        (
          line.match(
            /</g
          ) || []
        ).length;

      return chevrons >= 2;
    });

  if (candidates.length >= 2) {
    return candidates
      .slice(-2)
      .join("\n");
  }

  return null;
}


// =========================================================
// KK
// =========================================================

function parseKK(
  text,
  overlay
) {
  const lines =
    getLines(overlay);

  const noKK =
    extract16(text);

  const rows = [];

  // =======================================================
  // Cari header kolom
  // =======================================================

  let nikColumnX = null;
  let namaColumnX = null;
  let ayahColumnX = null;

  for (const line of lines) {
    const t =
      line.text.toUpperCase();

    if (
      t.includes("NIK")
    ) {
      nikColumnX =
        line.left;
    }

    if (
      t === "NAMA" ||
      t.startsWith("NAMA ")
    ) {
      namaColumnX =
        line.left;
    }

    if (
      t.includes("NAMA AYAH")
    ) {
      ayahColumnX =
        line.left;
    }
  }

  // =======================================================
  // Cari setiap NIK
  // =======================================================

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

    // -----------------------------------------------------
    // Nama
    // -----------------------------------------------------

    let nama = null;

    // Coba same line
    const words =
      line.words || [];

    const nikWord =
      words.find(w =>
        String(
          w.WordText || ""
        ).replace(/\D/g, "")
          .length >= 16
      );

    const nikX =
      Number(
        nikWord?.Left ??
        line.left
      );

    const candidates =
      lines.filter(l =>
        Math.abs(
          l.top - line.top
        ) <=
        Math.max(
          25,
          line.height * 2
        )
      );

    // Nama berada di area kolom nama
    if (namaColumnX != null) {
      const c =
        candidates.find(l =>
          Math.abs(
            l.left -
            namaColumnX
          ) < 120 &&
          !/\b\d{16}\b/.test(
            l.text
          )
        );

      if (c) {
        nama =
          clean(c.text);
      }
    }

    // Fallback: kata di kanan NIK
    if (!nama) {
      const c =
        candidates.find(l =>
          l.left > nikX + 40 &&
          !/\b\d{16}\b/.test(
            l.text
          )
        );

      if (c) {
        nama =
          clean(c.text);
      }
    }

    // -----------------------------------------------------
    // Nama Ayah
    //
    // WAJIB berasal dari kolom Nama Ayah.
    // BUKAN Kepala Keluarga.
    // -----------------------------------------------------

    let namaAyah = null;

    if (ayahColumnX != null) {
      const c =
        candidates.find(l =>
          Math.abs(
            l.left -
            ayahColumnX
          ) < 160 &&
          !/\b\d{16}\b/.test(
            l.text
          )
        );

      if (c) {
        namaAyah =
          clean(c.text);
      }
    }

    rows.push({
      nik,
      nama,
      nama_ayah:
        namaAyah
    });
  }

  // =======================================================
  // DEDUPE
  // =======================================================

  const map =
    new Map();

  for (const row of rows) {
    if (!map.has(row.nik)) {
      map.set(
        row.nik,
        row
      );
    }
  }

  return {
    document_type: "kk",

    no_kk: noKK,

    members:
      Array.from(
        map.values()
      )
  };
}


// =========================================================
// GENERIC
// =========================================================

function parseGeneric(text) {
  return {
    document_type:
      "unknown",

    nik:
      extract16(text),

    raw_text_available:
      true
  };
}


// =========================================================
// VALIDATION
// =========================================================

function validate(
  type,
  data
) {
  const missing = [];

  if (type === "ktp") {
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

  if (type === "passport") {
    if (!data.nomor_passport)
      missing.push(
        "Nomor Passport"
      );

    if (!data.nama)
      missing.push("Nama");

    if (!data.tanggal_lahir)
      missing.push(
        "Tanggal Lahir"
      );
  }

  if (type === "kk") {
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
      missing.length === 0,

    missing
  };
}
