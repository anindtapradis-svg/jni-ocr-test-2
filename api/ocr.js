// api/ocr.js

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({
      ok: false,
      error: "Method not allowed",
      method: req.method,
    });
  }

  try {
    const apiKey = process.env.OCR_SPACE_API_KEY;

    if (!apiKey) {
      return res.status(500).json({
        ok: false,
        error: "OCR_SPACE_API_KEY belum dikonfigurasi di Vercel.",
      });
    }

    const {
      documentType,
      fileName,
      mimeType,
      dataUrl,
    } = req.body || {};

    if (!dataUrl) {
      return res.status(400).json({
        ok: false,
        error: "File tidak ditemukan.",
      });
    }

    const allowedTypes = [
      "image/jpeg",
      "image/jpg",
      "image/png",
      "image/webp",
      "application/pdf",
    ];

    if (mimeType && !allowedTypes.includes(mimeType)) {
      return res.status(400).json({
        ok: false,
        error: "Format file tidak didukung.",
      });
    }

    /*
     * ============================================================
     * 1. PREPARE BASE64
     * ============================================================
     */

    const base64Image = dataUrl.includes(",")
      ? dataUrl.split(",")[1]
      : dataUrl;

    if (!base64Image) {
      return res.status(400).json({
        ok: false,
        error: "Data file kosong.",
      });
    }

    /*
     * ============================================================
     * 2. OCR.SPACE
     * ============================================================
     *
     * Jangan retry otomatis.
     * Satu dokumen = satu request OCR.
     */

    const form = new FormData();

    form.append(
      "base64Image",
      `data:${mimeType || "image/jpeg"};base64,${base64Image}`
    );

    form.append("apikey", apiKey);

    // Engine 2 dipertahankan karena hasil KTP sudah bagus.
    form.append("OCREngine", "2");

    form.append("language", "auto");

    form.append("isOverlayRequired", "true");

    form.append("detectOrientation", "true");

    form.append("scale", "true");

    // Table mode hanya untuk KK.
    if (String(documentType).toLowerCase() === "kk") {
      form.append("isTable", "true");
    } else {
      form.append("isTable", "false");
    }

    form.append("filetype", mimeType === "application/pdf" ? "PDF" : "JPG");

    const response = await fetch(
      "https://api.ocr.space/parse/image",
      {
        method: "POST",
        body: form,
      }
    );

    if (!response.ok) {
      return res.status(502).json({
        ok: false,
        error: `OCR provider HTTP ${response.status}`,
      });
    }

    const ocr = await response.json();

    if (ocr.IsErroredOnProcessing) {
      return res.status(422).json({
        ok: false,
        error:
          ocr.ErrorMessage?.join?.(" ") ||
          ocr.ErrorMessage ||
          "OCR gagal diproses.",
        ocr,
      });
    }

    /*
     * ============================================================
     * 3. RAW OCR TEXT
     * ============================================================
     */

    const parsedResults = Array.isArray(ocr.ParsedResults)
      ? ocr.ParsedResults
      : [];

    const rawText = parsedResults
      .map((x) => x?.ParsedText || "")
      .join("\n")
      .replace(/\r/g, "")
      .trim();

    /*
     * ============================================================
     * 4. OVERLAY WORDS
     * ============================================================
     */

    const overlayWords = [];

    for (const page of parsedResults) {
      const words = page?.TextOverlay?.Lines || [];

      for (const line of words) {
        const lineWords = Array.isArray(line?.Words)
          ? line.Words
          : [];

        for (const word of lineWords) {
          if (!word?.WordText) continue;

          const left = Number(word.Left || 0);
          const top = Number(word.Top || 0);
          const width = Number(word.Width || 0);
          const height = Number(word.Height || 0);

          overlayWords.push({
            text: String(word.WordText).trim(),
            left,
            top,
            width,
            height,
            right: left + width,
            bottom: top + height,
            centerX: left + width / 2,
            centerY: top + height / 2,
          });
        }
      }
    }

    /*
     * ============================================================
     * 5. NORMALIZATION HELPERS
     * ============================================================
     */

    function cleanText(value) {
      if (value == null) return null;

      const v = String(value)
        .replace(/\s+/g, " ")
        .replace(/[|]+/g, " ")
        .trim();

      if (!v) return null;

      return v;
    }

    function upper(value) {
      return cleanText(value)?.toUpperCase() || "";
    }

    function linesFromText(text) {
      return String(text || "")
        .split("\n")
        .map((x) => x.trim())
        .filter(Boolean);
    }

    const textLines = linesFromText(rawText);

    function normalizeOCRText(value) {
      return upper(value)
        .replace(/[“”"']/g, "")
        .replace(/\s+/g, " ")
        .trim();
    }

    function isLabelOnly(value) {
      const v = normalizeOCRText(value);

      if (!v) return true;

      const labels = [
        "NAME",
        "NAMA",
        "SURNAME",
        "GIVEN NAMES",
        "NATIONALITY",
        "KEWARGANEGARAAN",
        "DATE OF BIRTH",
        "TANGGAL LAHIR",
        "PLACE OF BIRTH",
        "TEMPAT LAHIR",
        "SEX",
        "JENIS KELAMIN",
        "DATE OF ISSUE",
        "TANGGAL TERBIT",
        "DATE OF EXPIRY",
        "TANGGAL EXPIRED",
        "ISSUING AUTHORITY",
        "ISSUING OFFICE",
        "KANTOR",
        "NIK",
        "ALAMAT",
        "RT/RW",
        "KELURAHAN",
        "DESA",
        "KECAMATAN",
      ];

      return labels.some((label) => {
        return (
          v === label ||
          v.endsWith(` ${label}`) ||
          v.startsWith(`${label} `)
        );
      });
    }

    /*
     * ============================================================
     * 6. GENERIC VALUE AFTER LABEL
     * ============================================================
     */

    function valueAfterLabel(lines, labels, options = {}) {
      const normalizedLabels = labels.map((x) =>
        normalizeOCRText(x)
      );

      const maxNext = options.maxNext ?? 2;

      for (let i = 0; i < lines.length; i++) {
        const original = lines[i];
        const current = normalizeOCRText(original);

        for (const label of normalizedLabels) {
          if (!label) continue;

          // LABEL : VALUE
          if (current.startsWith(label)) {
            let remainder = original
              .replace(
                new RegExp(
                  "^\\s*" +
                    label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") +
                    "\\s*[:\\-]?\\s*",
                  "i"
                ),
                ""
              )
              .trim();

            if (
              remainder &&
              normalizeOCRText(remainder) !== label &&
              !isLabelOnly(remainder)
            ) {
              return cleanText(remainder);
            }
          }
        }

        // LABEL di satu baris → nilai di baris berikutnya
        if (
          normalizedLabels.some((label) =>
            current === label ||
            current.replace(/[:\-]/g, "").trim() === label
          )
        ) {
          for (
            let j = i + 1;
            j <= Math.min(lines.length - 1, i + maxNext);
            j++
          ) {
            const candidate = cleanText(lines[j]);

            if (!candidate) continue;

            if (isLabelOnly(candidate)) continue;

            return candidate;
          }
        }
      }

      return null;
    }

    /*
     * ============================================================
     * 7. DATE HELPERS
     * ============================================================
     */

    const MONTHS = {
      JAN: "JAN",
      JANUARY: "JAN",
      FEB: "FEB",
      FEBRUARY: "FEB",
      MAR: "MAR",
      MARCH: "MAR",
      APR: "APR",
      APRIL: "APR",
      MAY: "MAY",
      JUN: "JUN",
      JUNE: "JUN",
      JUL: "JUL",
      JULY: "JUL",
      AUG: "AUG",
      AUGUST: "AUG",
      SEP: "SEP",
      SEPT: "SEP",
      SEPTEMBER: "SEP",
      OCT: "OCT",
      OCTOBER: "OCT",
      NOV: "NOV",
      NOVEMBER: "NOV",
      DEC: "DEC",
      DECEMBER: "DEC",
    };

    function normalizeDate(value) {
      if (!value) return null;

      let v = upper(value)
        .replace(/[.,]/g, " ")
        .replace(/\s+/g, " ")
        .trim();

      // 17 AUG 1985
      let m = v.match(
        /\b(\d{1,2})\s+([A-Z]{3,9})\s+(\d{4})\b/
      );

      if (m) {
        const month = MONTHS[m[2]];

        if (month) {
          return `${String(m[1]).padStart(2, "0")} ${month} ${m[3]}`;
        }
      }

      // 17-08-1985 / 17/08/1985 / 17.08.1985
      m = v.match(
        /\b(\d{1,2})\s*[-/]\s*(\d{1,2})\s*[-/]\s*(\d{4})\b/
      );

      if (m) {
        const months = [
          "JAN",
          "FEB",
          "MAR",
          "APR",
          "MAY",
          "JUN",
          "JUL",
          "AUG",
          "SEP",
          "OCT",
          "NOV",
          "DEC",
        ];

        const monthIndex = Number(m[2]);

        if (monthIndex >= 1 && monthIndex <= 12) {
          return `${String(m[1]).padStart(2, "0")} ${
            months[monthIndex - 1]
          } ${m[3]}`;
        }
      }

      return null;
    }

    function findDates(value) {
      if (!value) return [];

      const text = upper(value)
        .replace(/[.,]/g, " ")
        .replace(/\s+/g, " ");

      const results = [];

      const monthRegex =
        /\b\d{1,2}\s+(?:JAN(?:UARY)?|FEB(?:RUARY)?|MAR(?:CH)?|APR(?:IL)?|MAY|JUN(?:E)?|JUL(?:Y)?|AUG(?:UST)?|SEP(?:TEMBER)?|OCT(?:OBER)?|NOV(?:EMBER)?|DEC(?:EMBER)?)\s+\d{4}\b/g;

      for (const m of text.matchAll(monthRegex)) {
        const d = normalizeDate(m[0]);

        if (d) results.push(d);
      }

      const numericRegex =
        /\b\d{1,2}\s*[-/]\s*\d{1,2}\s*[-/]\s*\d{4}\b/g;

      for (const m of text.matchAll(numericRegex)) {
        const d = normalizeDate(m[0]);

        if (d) results.push(d);
      }

      return [...new Set(results)];
    }

    function isDate(value) {
      return !!normalizeDate(value);
    }

    /*
     * ============================================================
     * 8. KTP PARSER
     * ============================================================
     *
     * BAGIAN INI DIJAGA supaya field KTP yang sudah bagus
     * tidak rusak.
     */

    function parseNIK(text) {
      const matches = String(text || "").match(/\b\d{16}\b/g);

      if (!matches) return null;

      // Pilih NIK pertama yang masuk akal.
      for (const nik of matches) {
        const firstTwo = Number(nik.slice(0, 2));
        const city = Number(nik.slice(0, 6));
        const month = Number(nik.slice(8, 10));
        const dayRaw = Number(nik.slice(6, 8));

        let day = dayRaw;

        if (day > 40) {
          day -= 40;
        }

        if (
          firstTwo >= 11 &&
          firstTwo <= 99 &&
          city >= 110000 &&
          month >= 1 &&
          month <= 12 &&
          day >= 1 &&
          day <= 31
        ) {
          return nik;
        }
      }

      return matches[0];
    }

    function normalizeGender(value) {
      const v = upper(value);

      if (!v) return null;

      if (
        v.includes("LAKI") ||
        v === "L" ||
        v === "MALE" ||
        v === "M"
      ) {
        return "LAKI-LAKI";
      }

      if (
        v.includes("PEREMPUAN") ||
        v.includes("WANITA") ||
        v === "P" ||
        v === "F" ||
        v === "FEMALE"
      ) {
        return "PEREMPUAN";
      }

      return cleanText(value);
    }

    function extractKTPBirth(line) {
      if (!line) return null;

      let value = cleanText(line);

      // Hapus label TEMPAT/TGL LAHIR jika ikut terbaca.
      value = value.replace(
        /^\s*(TEMPAT\/?TGL\.?\s*LAHIR|TEMPAT\s+TGL\s+LAHIR|TEMPAT\s+LAHIR|TTL)\s*[:\-]?\s*/i,
        ""
      );

      value = cleanText(value);

      if (!value) return null;

      const dates = findDates(value);

      if (!dates.length) return null;

      const date = dates[0];

      // Ambil bagian sebelum tanggal sebagai tempat lahir.
      const dateIndex = upper(value).indexOf(
        upper(
          value.match(
            /\d{1,2}\s*[-/ ]\s*[A-Z0-9]{2,9}\s*[-/ ]\s*\d{4}/i
          )?.[0] || ""
        )
      );

      let place = null;

      // Cara yang lebih aman: hapus semua format tanggal dari value.
      place = value
        .replace(
          /\b\d{1,2}\s+(?:JAN(?:UARY)?|FEB(?:RUARY)?|MAR(?:CH)?|APR(?:IL)?|MAY|JUN(?:E)?|JUL(?:Y)?|AUG(?:UST)?|SEP(?:TEMBER)?|OCT(?:OBER)?|NOV(?:EMBER)?|DEC(?:EMBER)?)\s+\d{4}\b/gi,
          ""
        )
        .replace(
          /\b\d{1,2}\s*[-/]\s*\d{1,2}\s*[-/]\s*\d{4}\b/g,
          ""
        )
        .replace(/\s{2,}/g, " ")
        .replace(/^[,;:\-]+|[,;:\-]+$/g, "")
        .trim();

      // Kalau tempat masih mengandung label, bersihkan.
      place = place
        .replace(/^[:\-\/,\s]+/, "")
        .trim();

      if (!place || isLabelOnly(place)) {
        place = null;
      }

      return {
        tempat_lahir: place,
        tanggal_lahir: date,
      };
    }

    function parseKTP(text) {
      const lines = linesFromText(text);

      const result = {
        nik: parseNIK(text),
        nama: null,
        tempat_lahir: null,
        tanggal_lahir: null,
        jenis_kelamin: null,
        alamat: null,
        rt_rw: null,
        kelurahan_desa: null,
        kecamatan: null,
        status_perkawinan: null,
        pekerjaan: null,
        kewarganegaraan: null,
      };

      /*
       * NAMA
       */
      result.nama = valueAfterLabel(lines, ["NAMA"]);

      /*
       * TTL
       *
       * Prioritas:
       * 1. baris TEMPAT/TGL LAHIR
       * 2. baris yang mengandung tanggal + teks sebelum tanggal
       */

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        const normalized = normalizeOCRText(line);

        if (
          normalized.includes("TEMPAT") &&
          normalized.includes("LAHIR")
        ) {
          const ttl = extractKTPBirth(line);

          if (ttl) {
            result.tempat_lahir = ttl.tempat_lahir;
            result.tanggal_lahir = ttl.tanggal_lahir;
            break;
          }

          // Jika label sendiri, cek baris berikutnya.
          for (
            let j = i + 1;
            j <= Math.min(i + 2, lines.length - 1);
            j++
          ) {
            const ttlNext = extractKTPBirth(lines[j]);

            if (ttlNext) {
              result.tempat_lahir = ttlNext.tempat_lahir;
              result.tanggal_lahir = ttlNext.tanggal_lahir;
              break;
            }
          }
        }
      }

      /*
       * Kalau belum dapat, cari baris yang punya tanggal.
       */
      if (!result.tanggal_lahir) {
        for (const line of lines) {
          const dates = findDates(line);

          if (!dates.length) continue;

          const normalized = normalizeOCRText(line);

          // Hindari mengambil tanggal dari bagian lain.
          if (
            normalized.includes("BERLAKU") ||
            normalized.includes("HINGGA") ||
            normalized.includes("TERBIT")
          ) {
            continue;
          }

          const ttl = extractKTPBirth(line);

          if (ttl?.tanggal_lahir) {
            result.tanggal_lahir = ttl.tanggal_lahir;

            if (ttl.tempat_lahir) {
              result.tempat_lahir = ttl.tempat_lahir;
            }

            break;
          }
        }
      }

      /*
       * Kalau tempat lahir masih kosong, cari pola:
       *
       * TEMPAT LAHIR
       * DEPOK, 14-10-1999
       */

      if (!result.tempat_lahir || !result.tanggal_lahir) {
        for (let i = 0; i < lines.length; i++) {
          const normalized = normalizeOCRText(lines[i]);

          if (
            normalized === "TEMPAT LAHIR" ||
            normalized === "TEMPAT/TGL LAHIR" ||
            normalized === "TEMPAT TGL LAHIR" ||
            normalized === "TTL"
          ) {
            for (
              let j = i + 1;
              j <= Math.min(i + 2, lines.length - 1);
              j++
            ) {
              const ttl = extractKTPBirth(lines[j]);

              if (ttl) {
                result.tempat_lahir ||= ttl.tempat_lahir;
                result.tanggal_lahir ||= ttl.tanggal_lahir;
                break;
              }
            }
          }
        }
      }

      /*
       * JENIS KELAMIN
       */
      const genderValue = valueAfterLabel(lines, [
        "JENIS KELAMIN",
      ]);

      result.jenis_kelamin = normalizeGender(genderValue);

      /*
       * ALAMAT
       */
      result.alamat = valueAfterLabel(lines, ["ALAMAT"]);

      /*
       * RT/RW
       */
      for (const line of lines) {
        const m = line.match(
          /\b(\d{1,3})\s*[/\-]\s*(\d{1,3})\b/
        );

        if (m) {
          const candidate = `${m[1].padStart(
            3,
            "0"
          )}/${m[2].padStart(3, "0")}`;

          if (
            candidate !== "000/000" &&
            !isDate(line)
          ) {
            result.rt_rw = candidate;
            break;
          }
        }
      }

      if (!result.rt_rw) {
        result.rt_rw = valueAfterLabel(lines, [
          "RT/RW",
          "RT RW",
        ]);
      }

      /*
       * KELURAHAN / DESA
       */
      result.kelurahan_desa = valueAfterLabel(lines, [
        "KELURAHAN/DESA",
        "KELURAHAN",
        "DESA",
      ]);

      /*
       * KECAMATAN
       */
      result.kecamatan = valueAfterLabel(lines, [
        "KECAMATAN",
      ]);

      /*
       * STATUS PERKAWINAN
       */
      result.status_perkawinan = valueAfterLabel(lines, [
        "STATUS PERKAWINAN",
        "STATUS PERKAWINAN MENURUT",
      ]);

      /*
       * PEKERJAAN
       */
      result.pekerjaan = valueAfterLabel(lines, [
        "PEKERJAAN",
      ]);

      /*
       * KEWARGANEGARAAN
       */
      result.kewarganegaraan = valueAfterLabel(lines, [
        "KEWARGANEGARAAN",
      ]);

      return result;
    }

    /*
     * ============================================================
     * 9. PASSPORT HELPERS
     * ============================================================
     */

    function cleanPassportValue(value) {
      if (!value) return null;

      let v = cleanText(value);

      if (!v) return null;

      v = v
        .replace(/^[:\-\/]+/, "")
        .replace(/[:\-\/]+$/, "")
        .trim();

      if (!v) return null;

      return v;
    }

    function isPassportNumber(value) {
      if (!value) return false;

      const v = upper(value).replace(/\s+/g, "");

      /*
       * Passport Indonesia umumnya:
       * 1 huruf + 7 digit
       *
       * Tetapi jangan terlalu kaku.
       */
      return /^[A-Z][0-9]{7}$/.test(v) ||
        /^[A-Z0-9]{7,9}$/.test(v);
    }

    function normalizePassportNumber(value) {
      if (!value) return null;

      const v = upper(value)
        .replace(/[^A-Z0-9]/g, "")
        .trim();

      if (!isPassportNumber(v)) return null;

      return v;
    }

    function isNationality(value) {
      if (!value) return false;

      const v = upper(value);

      if (isDate(v)) return false;

      if (
        v.includes("PLACE OF") ||
        v.includes("DATE OF") ||
        v.includes("BIRTH") ||
        v.includes("ISSUE") ||
        v.includes("EXPIR") ||
        v.includes("AUTHORITY") ||
        v.includes("OFFICE") ||
        v.includes("PASSPORT") ||
        v.includes("NAME")
      ) {
        return false;
      }

      /*
       * Jangan menerima kalimat template hukum passport
       * sebagai nationality.
       */
      if (
        v.includes("REPUBLIC") ||
        v.includes("REPUBLIC OF") ||
        v.includes("DIATUR") ||
        v.includes("UNDANG") ||
        v.includes("LAW") ||
        v.includes("MINISTRY") ||
        v.includes("MINISTER")
      ) {
        return false;
      }

      /*
       * Nilai yang umum.
       */
      const valid = [
        "INDONESIAN",
        "INDONESIA",
        "IDN",
        "WNI",
        "MALAYSIAN",
        "MALAYSIA",
        "MYS",
        "SINGAPOREAN",
        "SINGAPORE",
        "SGP",
      ];

      if (valid.includes(v)) return true;

      /*
       * Kalau berupa 3 huruf kode negara.
       */
      if (/^[A-Z]{3}$/.test(v)) return true;

      return false;
    }

    function normalizeNationality(value) {
      if (!value) return null;

      const v = upper(value);

      if (
        v === "IDN" ||
        v === "INDONESIA" ||
        v === "INDONESIAN" ||
        v === "WNI"
      ) {
        return "INDONESIAN";
      }

      return cleanPassportValue(value);
    }

    function normalizeSex(value) {
      if (!value) return null;

      const v = upper(value)
        .replace(/[.:;\/\\]/g, " ")
        .replace(/\s+/g, " ")
        .trim();

      if (
        v === "M" ||
        v === "MALE" ||
        v.includes(" MALE")
      ) {
        return "M";
      }

      if (
        v === "F" ||
        v === "FEMALE" ||
        v.includes(" FEMALE")
      ) {
        return "F";
      }

      return null;
    }

    function isPassportPlace(value) {
      if (!value) return false;

      const v = upper(value)
        .replace(/\s+/g, " ")
        .trim();

      if (!v) return false;

      if (isDate(v)) return false;

      /*
       * Ini penting untuk bug sebelumnya:
       * "/ PLACE OF BIRTH"
       * tidak boleh dianggap sebagai tempat lahir.
       */
      if (
        v.includes("PLACE OF BIRTH") ||
        v === "PLACE OF BIRTH" ||
        v.includes("/ PLACE OF BIRTH") ||
        v.includes("DATE OF BIRTH") ||
        v.includes("DATE OF ISSUE") ||
        v.includes("DATE OF EXPIRY") ||
        v.includes("ISSUING AUTHORITY") ||
        v.includes("ISSUING OFFICE")
      ) {
        return false;
      }

      if (
        v.length < 2 ||
        v.length > 80
      ) {
        return false;
      }

      return true;
    }

    function isPassportName(value) {
      if (!value) return false;

      const v = upper(value)
        .replace(/\s+/g, " ")
        .trim();

      if (v.length < 3 || v.length > 80) {
        return false;
      }

      if (
        v.includes("SURNAME") ||
        v.includes("GIVEN NAME") ||
        v.includes("NATIONALITY") ||
        v.includes("DATE OF") ||
        v.includes("PLACE OF") ||
        v.includes("ISSUING")
      ) {
        return false;
      }

      if (isDate(v)) return false;

      // Nama normal harus dominan huruf.
      if (!/[A-Z]{2,}/.test(v)) return false;

      return true;
    }

    /*
     * ============================================================
     * 10. PASSPORT MRZ
     * ============================================================
     */

    function cleanMRZLine(value) {
      if (!value) return null;

      let v = upper(value)
        .replace(/\s+/g, "")
        .replace(/[«‹]/g, "<")
        .replace(/[|]/g, "I")
        .trim();

      if (v.length < 25) return null;

      // MRZ hanya boleh berisi A-Z, 0-9 dan <
      v = v.replace(/[^A-Z0-9<]/g, "");

      if (v.length < 25) return null;

      return v;
    }

    function looksLikeMRZ(value) {
      const v = cleanMRZLine(value);

      if (!v) return false;

      const hasLongLength = v.length >= 30;
      const hasChevron = v.includes("<");
      const hasPassportStart = /^P[A-Z0-9<]/.test(v);

      return (
        hasLongLength &&
        (hasChevron || hasPassportStart)
      );
    }

    function parseMRZ(text) {
      const lines = linesFromText(text);

      const candidates = lines
        .map(cleanMRZLine)
        .filter(Boolean);

      let first = null;
      let second = null;

      for (let i = 0; i < candidates.length; i++) {
        if (!looksLikeMRZ(candidates[i])) continue;

        if (!first) {
          first = candidates[i];
          continue;
        }

        if (
          candidates[i].length >= 30
        ) {
          second = candidates[i];
          break;
        }
      }

      if (!first || !second) {
        return {
          raw: null,
          passport_number: null,
          nationality: null,
          date_of_birth: null,
          sex: null,
          date_of_expiry: null,
          surname: null,
          given_names: null,
        };
      }

      const line1 = first.padEnd(44, "<").slice(0, 44);
      const line2 = second.padEnd(44, "<").slice(0, 44);

      let passportNumber =
        line2.slice(0, 9).replace(/</g, "");

      let nationality =
        line2.slice(10, 13).replace(/</g, "");

      let dobRaw =
        line2.slice(13, 19);

      let sex =
        line2.slice(20, 21);

      let expiryRaw =
        line2.slice(21, 27);

      function mrzDate(raw) {
        if (!/^\d{6}$/.test(raw)) {
          return null;
        }

        const yy = Number(raw.slice(0, 2));
        const mm = Number(raw.slice(2, 4));
        const dd = Number(raw.slice(4, 6));

        if (
          mm < 1 ||
          mm > 12 ||
          dd < 1 ||
          dd > 31
        ) {
          return null;
        }

        /*
         * Passport DOB / expiry:
         * tentukan century berdasarkan konteks sederhana.
         */
        const currentYear = new Date().getFullYear();
        const currentYY = currentYear % 100;

        let year;

        if (yy <= currentYY + 10) {
          year = 2000 + yy;
        } else {
          year = 1900 + yy;
        }

        const months = [
          "JAN",
          "FEB",
          "MAR",
          "APR",
          "MAY",
          "JUN",
          "JUL",
          "AUG",
          "SEP",
          "OCT",
          "NOV",
          "DEC",
        ];

        return `${String(dd).padStart(2, "0")} ${
          months[mm - 1]
        } ${year}`;
      }

      let surname = null;
      let givenNames = null;

      const namePart = line1.slice(5, 44);

      if (namePart) {
        const parts = namePart
          .split("<<")
          .map((x) => x.replace(/</g, " ").trim())
          .filter(Boolean);

        surname = parts[0] || null;
        givenNames = parts.slice(1).join(" ") || null;
      }

      const dob = mrzDate(dobRaw);
      const expiry = mrzDate(expiryRaw);

      return {
        raw: `${first}\n${second}`,
        passport_number: passportNumber || null,
        nationality: nationality || null,
        date_of_birth: dob,
        sex:
          sex === "M" || sex === "F"
            ? sex
            : null,
        date_of_expiry: expiry,
        surname,
        given_names: givenNames,
      };
    }

    /*
     * ============================================================
     * 11. PASSPORT LABEL EXTRACTION
     * ============================================================
     */

    function getPassportLabelValue(
      lines,
      labelVariants,
      validator
    ) {
      const labels = labelVariants.map(normalizeOCRText);

      for (let i = 0; i < lines.length; i++) {
        const original = lines[i];
        const current = normalizeOCRText(original);

        for (const label of labels) {
          if (!label) continue;

          /*
           * CASE A:
           *
           * NATIONALITY INDONESIAN
           */
          if (current.startsWith(label + " ")) {
            let remainder = original
              .slice(
                original
                  .toUpperCase()
                  .indexOf(label) + label.length
              )
              .trim();

            remainder = remainder
              .replace(/^[:\-\/]+/, "")
              .trim();

            if (
              remainder &&
              !isLabelOnly(remainder) &&
              (!validator || validator(remainder))
            ) {
              return cleanPassportValue(remainder);
            }
          }

          /*
           * CASE B:
           *
           * NATIONALITY
           * INDONESIAN
           */
          if (
            current === label ||
            current.replace(/[:\-]/g, "").trim() === label
          ) {
            for (
              let j = i + 1;
              j <= Math.min(lines.length - 1, i + 3);
              j++
            ) {
              const candidate = cleanPassportValue(
                lines[j]
              );

              if (!candidate) continue;

              if (isLabelOnly(candidate)) continue;

              if (
                validator &&
                !validator(candidate)
              ) {
                continue;
              }

              return candidate;
            }
          }
        }
      }

      return null;
    }

    /*
     * ============================================================
     * 12. PASSPORT DATE BY LABEL
     * ============================================================
     */

    function getPassportDate(lines, labels) {
      return getPassportLabelValue(
        lines,
        labels,
        (candidate) => {
          return !!normalizeDate(candidate);
        }
      );
    }

    /*
     * ============================================================
     * 13. PASSPORT PARSER
     * ============================================================
     */

    function parsePassport(text) {
      const lines = linesFromText(text);

      const mrz = parseMRZ(text);

      const result = {
        nomor_passport: null,
        nama: null,
        nationality: null,
        tanggal_lahir: null,
        tempat_lahir: null,
        jenis_kelamin: null,
        tanggal_terbit: null,
        tanggal_expired: null,
        issuing_office: null,
        mrz: mrz.raw,
      };

      /*
       * ----------------------------------------------------------
       * PASSPORT NUMBER
       * ----------------------------------------------------------
       */

      /*
       * Prioritas MRZ.
       */
      if (mrz.passport_number) {
        result.nomor_passport =
          normalizePassportNumber(
            mrz.passport_number
          );
      }

      /*
       * Cari dari teks biasa kalau MRZ tidak ada.
       */
      if (!result.nomor_passport) {
        for (const line of lines) {
          const normalized = normalizeOCRText(line);

          /*
           * Cari label PASSPORT / PASPOR / PASSPORT NO
           */
          if (
            normalized.includes("PASSPORT") ||
            normalized.includes("PASPOR")
          ) {
            const matches = line.match(
              /\b[A-Z][A-Z0-9]{6,8}\b/g
            );

            if (matches) {
              for (const candidate of matches) {
                const p =
                  normalizePassportNumber(candidate);

                if (p) {
                  result.nomor_passport = p;
                  break;
                }
              }
            }
          }

          if (result.nomor_passport) break;
        }
      }

      /*
       * Fallback: cari seluruh teks.
       */
      if (!result.nomor_passport) {
        const candidates = rawText.match(
          /\b[A-Z][A-Z0-9]{6,8}\b/g
        ) || [];

        for (const candidate of candidates) {
          const p =
            normalizePassportNumber(candidate);

          if (p) {
            /*
             * Hindari kata seperti PASSPORI.
             */
            if (
              ![
                "PASSPORT",
                "PASSPORI",
                "PASPOR",
              ].includes(p)
            ) {
              result.nomor_passport = p;
              break;
            }
          }
        }
      }

      /*
       * ----------------------------------------------------------
       * NAMA
       * ----------------------------------------------------------
       */

      let surname = null;
      let givenNames = null;

      surname = getPassportLabelValue(
        lines,
        ["SURNAME"],
        isPassportName
      );

      givenNames = getPassportLabelValue(
        lines,
        ["GIVEN NAMES", "GIVEN NAME"],
        isPassportName
      );

      if (surname && givenNames) {
        result.nama = `${surname} ${givenNames}`
          .replace(/\s+/g, " ")
          .trim();
      } else if (surname) {
        result.nama = surname;
      } else if (givenNames) {
        result.nama = givenNames;
      }

      /*
       * Fallback:
       * kalau passport OCR tidak memisahkan surname/given names,
       * cari label NAME.
       */
      if (!result.nama) {
        result.nama = getPassportLabelValue(
          lines,
          ["NAME", "NAMA"],
          isPassportName
        );
      }

      /*
       * Kalau MRZ punya nama, hanya gunakan jika hasil label
       * benar-benar kosong.
       */
      if (!result.nama) {
        const mrzName = [
          mrz.surname,
          mrz.given_names,
        ]
          .filter(Boolean)
          .join(" ")
          .trim();

        if (isPassportName(mrzName)) {
          result.nama = mrzName;
        }
      }

      /*
       * ----------------------------------------------------------
       * NATIONALITY
       * ----------------------------------------------------------
       */

      if (isNationality(mrz.nationality)) {
        result.nationality =
          normalizeNationality(
            mrz.nationality
          );
      }

      if (!result.nationality) {
        const nationality =
          getPassportLabelValue(
            lines,
            ["NATIONALITY"],
            isNationality
          );

        if (nationality) {
          result.nationality =
            normalizeNationality(nationality);
        }
      }

      /*
       * ----------------------------------------------------------
       * DATE OF BIRTH
       * ----------------------------------------------------------
       */

      if (mrz.date_of_birth) {
        result.tanggal_lahir =
          mrz.date_of_birth;
      }

      if (!result.tanggal_lahir) {
        result.tanggal_lahir =
          getPassportDate(lines, [
            "DATE OF BIRTH",
            "DATE OF BIRTH /",
            "TANGGAL LAHIR",
          ]);
      }

      /*
       * ----------------------------------------------------------
       * PLACE OF BIRTH
       * ----------------------------------------------------------
       *
       * BUG LAMA:
       * "/ PLACE OF BIRTH"
       * terbaca sebagai value.
       *
       * Sekarang:
       * - label tidak pernah dianggap value
       * - value harus lulus isPassportPlace()
       */

      result.tempat_lahir =
        getPassportLabelValue(
          lines,
          [
            "PLACE OF BIRTH",
            "PLACE OF BIRTH /",
            "TEMPAT LAHIR",
          ],
          isPassportPlace
        );

      /*
       * Kalau label OCR rusak seperti:
       *
       * / PLACE OF BIRTH
       *
       * coba cari baris setelahnya.
       */
      if (!result.tempat_lahir) {
        for (let i = 0; i < lines.length; i++) {
          const current =
            normalizeOCRText(lines[i]);

          if (
            current.includes("PLACE OF BIRTH")
          ) {
            for (
              let j = i + 1;
              j <= Math.min(i + 3, lines.length - 1);
              j++
            ) {
              const candidate =
                cleanPassportValue(lines[j]);

              if (
                candidate &&
                isPassportPlace(candidate)
              ) {
                result.tempat_lahir = candidate;
                break;
              }
            }
          }

          if (result.tempat_lahir) break;
        }
      }

      /*
       * ----------------------------------------------------------
       * SEX
       * ----------------------------------------------------------
       */

      if (mrz.sex) {
        result.jenis_kelamin =
          normalizeSex(mrz.sex);
      }

      if (!result.jenis_kelamin) {
        const sex =
          getPassportLabelValue(
            lines,
            [
              "SEX",
              "GENDER",
              "JENIS KELAMIN",
            ],
            (candidate) =>
              !!normalizeSex(candidate)
          );

        result.jenis_kelamin =
          normalizeSex(sex);
      }

      /*
       * ----------------------------------------------------------
       * DATE OF ISSUE
       * ----------------------------------------------------------
       */

      result.tanggal_terbit =
        getPassportDate(lines, [
          "DATE OF ISSUE",
          "DATE OF ISSUANCE",
          "TANGGAL TERBIT",
        ]);

      /*
       * ----------------------------------------------------------
       * DATE OF EXPIRY
       * ----------------------------------------------------------
       */

      if (mrz.date_of_expiry) {
        result.tanggal_expired =
          mrz.date_of_expiry;
      }

      if (!result.tanggal_expired) {
        result.tanggal_expired =
          getPassportDate(lines, [
            "DATE OF EXPIRY",
            "DATE OF EXPIRATION",
            "EXPIRY DATE",
            "TANGGAL EXPIRED",
            "TANGGAL BERLAKU",
          ]);
      }

      /*
       * ----------------------------------------------------------
       * ISSUING OFFICE
       * ----------------------------------------------------------
       */

      result.issuing_office =
        getPassportLabelValue(
          lines,
          [
            "ISSUING AUTHORITY",
            "ISSUING OFFICE",
            "AUTHORITY",
          ],
          (candidate) => {
            const v = normalizeOCRText(candidate);

            if (!v) return false;

            if (
              v.includes("DATE OF") ||
              v.includes("PLACE OF") ||
              v.includes("NATIONALITY") ||
              isDate(v)
            ) {
              return false;
            }

            return v.length >= 2;
          }
        );

      /*
       * ----------------------------------------------------------
       * SAFETY CLEANUP
       * ----------------------------------------------------------
       */

      if (
        result.tempat_lahir &&
        !isPassportPlace(result.tempat_lahir)
      ) {
        result.tempat_lahir = null;
      }

      if (
        result.nationality &&
        !isNationality(result.nationality)
      ) {
        result.nationality = null;
      }

      if (
        result.tanggal_lahir &&
        !isDate(result.tanggal_lahir)
      ) {
        result.tanggal_lahir = null;
      }

      if (
        result.tanggal_terbit &&
        !isDate(result.tanggal_terbit)
      ) {
        result.tanggal_terbit = null;
      }

      if (
        result.tanggal_expired &&
        !isDate(result.tanggal_expired)
      ) {
        result.tanggal_expired = null;
      }

      return result;
    }

    /*
     * ============================================================
     * 14. KK PARSER
     * ============================================================
     *
     * Jangan menebak Nama Ayah dari Kepala Keluarga.
     * Untuk sekarang hanya ambil data yang benar-benar terbaca.
     */

    function parseKK(text) {
      const lines = linesFromText(text);

      const result = {
        no_kk: null,
        nik: null,
        nama: null,
        nama_ayah: null,
      };

      /*
       * No KK = 16 digit.
       */
      const all16 = text.match(/\b\d{16}\b/g) || [];

      if (all16.length) {
        result.no_kk = all16[0];
      }

      /*
       * Cari NIK kedua kalau tersedia.
       */
      if (all16.length >= 2) {
        result.nik = all16[1];
      }

      /*
       * Nama.
       */
      result.nama =
        valueAfterLabel(lines, ["NAMA"]);

      /*
       * Nama Ayah sengaja TIDAK ditebak.
       *
       * Akan diisi jika OCR menemukan kolom:
       * NAMA AYAH
       */
      result.nama_ayah =
        valueAfterLabel(lines, [
          "NAMA AYAH",
        ]);

      return result;
    }

    /*
     * ============================================================
     * 15. DOCUMENT TYPE
     * ============================================================
     */

    function detectDocumentType(type, text) {
      const t = String(type || "")
        .toLowerCase()
        .trim();

      if (
        ["ktp", "kk", "passport"].includes(t)
      ) {
        return t;
      }

      const u = upper(text);

      if (
        u.includes("KARTU KELUARGA") ||
        u.includes("NAMA AYAH")
      ) {
        return "kk";
      }

      if (
        u.includes("REPUBLIK INDONESIA") &&
        (
          u.includes("PASSPORT") ||
          u.includes("PASSPOR") ||
          u.includes("NATIONALITY")
        )
      ) {
        return "passport";
      }

      return "ktp";
    }

    const detectedType =
      detectDocumentType(
        documentType,
        rawText
      );

    /*
     * ============================================================
     * 16. PARSE
     * ============================================================
     */

    let data;

    if (detectedType === "passport") {
      data = parsePassport(rawText);
    } else if (detectedType === "kk") {
      data = parseKK(rawText);
    } else {
      data = parseKTP(rawText);
    }

    /*
     * ============================================================
     * 17. VALIDATION
     * ============================================================
     */

    function validateKTP(data) {
      const missing = [];

      const required = {
        nik: "NIK",
        nama: "Nama",
        tempat_lahir: "Tempat Lahir",
        tanggal_lahir: "Tanggal Lahir",
        jenis_kelamin: "Jenis Kelamin",
        alamat: "Alamat",
        rt_rw: "RT/RW",
        kelurahan_desa: "Kelurahan/Desa",
        kecamatan: "Kecamatan",
        status_perkawinan: "Status Perkawinan",
        pekerjaan: "Pekerjaan",
        kewarganegaraan: "Kewarganegaraan",
      };

      for (const [key, label] of Object.entries(
        required
      )) {
        if (!data[key]) {
          missing.push(label);
        }
      }

      const invalid = [];

      if (
        data.nik &&
        !/^\d{16}$/.test(data.nik)
      ) {
        invalid.push("NIK");
      }

      if (
        data.tanggal_lahir &&
        !isDate(data.tanggal_lahir)
      ) {
        invalid.push("Tanggal Lahir");
      }

      return {
        ok:
          missing.length === 0 &&
          invalid.length === 0,
        missing,
        invalid,
      };
    }

    function validatePassport(data) {
      const missing = [];

      const required = {
        nomor_passport: "Nomor Passport",
        nama: "Nama",
        nationality: "Nationality",
        tanggal_lahir: "Tanggal Lahir",
        tempat_lahir: "Tempat Lahir",
        jenis_kelamin: "Jenis Kelamin",
        tanggal_terbit: "Tanggal Terbit",
        tanggal_expired: "Tanggal Expired",
        issuing_office: "Issuing Office",
        mrz: "MRZ",
      };

      for (const [key, label] of Object.entries(
        required
      )) {
        if (!data[key]) {
          missing.push(label);
        }
      }

      const invalid = [];

      if (
        data.nomor_passport &&
        !isPassportNumber(
          data.nomor_passport
        )
      ) {
        invalid.push("Nomor Passport");
      }

      if (
        data.nationality &&
        !isNationality(data.nationality)
      ) {
        invalid.push("Nationality");
      }

      if (
        data.tanggal_lahir &&
        !isDate(data.tanggal_lahir)
      ) {
        invalid.push("Tanggal Lahir");
      }

      if (
        data.tanggal_terbit &&
        !isDate(data.tanggal_terbit)
      ) {
        invalid.push("Tanggal Terbit");
      }

      if (
        data.tanggal_expired &&
        !isDate(data.tanggal_expired)
      ) {
        invalid.push("Tanggal Expired");
      }

      if (
        data.tempat_lahir &&
        !isPassportPlace(data.tempat_lahir)
      ) {
        invalid.push("Tempat Lahir");
      }

      return {
        ok:
          missing.length === 0 &&
          invalid.length === 0,
        missing,
        invalid,
      };
    }

    function validateKK(data) {
      const missing = [];

      const required = {
        no_kk: "No. KK",
        nik: "NIK",
        nama: "Nama",
        nama_ayah: "Nama Ayah",
      };

      for (const [key, label] of Object.entries(
        required
      )) {
        if (!data[key]) {
          missing.push(label);
        }
      }

      return {
        ok: missing.length === 0,
        missing,
        invalid: [],
      };
    }

    let validation;

    if (detectedType === "passport") {
      validation =
        validatePassport(data);
    } else if (detectedType === "kk") {
      validation =
        validateKK(data);
    } else {
      validation =
        validateKTP(data);
    }

    /*
     * ============================================================
     * 18. RESPONSE
     * ============================================================
     */

    return res.status(200).json({
      ok: true,

      documentType: detectedType,

      fileName:
        fileName || null,

      data,

      validation,

      /*
       * Debug sementara.
       * Nanti kalau parser sudah stabil bisa kita sembunyikan.
       */
      rawText,

      overlay: overlayWords,

      ocr: {
        parsedResultsCount:
          parsedResults.length,
        processingTimeInMilliseconds:
          ocr.ProcessingTimeInMilliseconds ||
          null,
        engine:
          ocr.OCRExitCode ||
          null,
      },
    });
  } catch (error) {
    console.error("OCR ERROR:", error);

    return res.status(500).json({
      ok: false,
      error:
        error?.message ||
        "Terjadi kesalahan pada server OCR.",
    });
  }
}
